import cors from 'cors'
import crypto from 'crypto'
import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import multer from 'multer'
import path, { dirname } from 'path'
import db, { initializeMySQLDatabase, testConnection } from './db.js'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express()
const PORT = process.env.PORT || 5000

// CORS configuration for Fly.io
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'https://uyho.org',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}

// Middleware - MUST be before routes
app.use(cors(corsOptions))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve static files from public directory
app.use('/public', express.static(path.join(__dirname, 'public')))

// Health check endpoint for Fly.io
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Multer setup for avatar uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'avatars'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${req.params.id}${ext}`);
  }
});
const upload = multer({ storage });

// Ensure avatars directory exists
const avatarsDir = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

// Initialize MySQL database
async function startDatabase() {
  const connected = await testConnection();
  if (connected) {
    await initializeMySQLDatabase();
    console.log('Connected to MySQL database');
  } else {
    console.error('Failed to connect to MySQL database. Check your .env credentials.');
    process.exit(1);
  }
}
startDatabase();

// Utility: add column if missing (MySQL version - columns are created in db.js)
function addColumnIfNotExists(table, column, type, defaultValue = null) {
  // MySQL handles this in db.js initialization
  // This function is kept for backward compatibility but does nothing
}

// Utility: keep volunteers_joined in sync with campaign_team
function syncCampaignJoined(campaignId) {
  db.get('SELECT COUNT(*) AS count FROM campaign_team WHERE campaign_id = ?', [campaignId], (err, row) => {
    if (err) {
      console.error('[Campaign Sync] Failed to count team members:', err)
      return
    }
    const count = row?.count || 0
    db.run('UPDATE campaigns SET volunteers_joined = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [count, campaignId], (updateErr) => {
      if (updateErr) {
        console.error('[Campaign Sync] Failed to update volunteers_joined:', updateErr)
      }
    })
  })
}

// Initialize database - handled by db.js for MySQL
function initializeDatabase() {
  // All tables are created in db.js with proper MySQL syntax
  console.log('[DB] Using MySQL - tables initialized via db.js')
}

// Routes
app.get('/api/team-members', (req, res) => {
  db.all('SELECT * FROM team_members ORDER BY category DESC, id', (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(rows)
  })
})

app.get('/api/team-members/:id', (req, res) => {
  const { id } = req.params
  db.get('SELECT * FROM team_members WHERE id = ?', [id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(row)
  })
})

app.get('/api/team-members/category/:category', (req, res) => {
  const { category } = req.params
  db.all('SELECT * FROM team_members WHERE category = ? ORDER BY id', [category], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(rows)
  })
})

app.post('/api/team-members', (req, res) => {
  const { name, position, specialty, category } = req.body
  const stmt = db.prepare(`
    INSERT INTO team_members (name, position, specialty, category)
    VALUES (?, ?, ?, ?)
  `)
  stmt.run(name, position, specialty, category, function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ id: this.lastID, name, position, specialty, category })
  })
  stmt.finalize()
})

// Volunteer registration endpoint
app.post('/api/volunteers/register', (req, res) => {
  const { fullName, email, password, phone, age, address, wing, availability, avatar } = req.body

  // Hash password (simple hash for demo, use bcrypt in production)
  const hashedPassword = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex')

  // Generate digital ID: UYHO-YYYY-SEQUENCE
  const year = new Date().getFullYear()
  db.get('SELECT COUNT(*) as count FROM volunteers', (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }

    const sequenceNumber = String(row.count + 1).padStart(3, '0')
    const digitalId = `UYHO-${year}-${sequenceNumber}`

    const stmt = db.prepare(`
      INSERT INTO volunteers (full_name, email, password, phone, age, address, wing, avatar, position, lives_impacted, teams_led, hours_given, availability, digital_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Volunteer', 0, 0, 0, ?, ?)
    `)

    stmt.run(
      fullName,
      email,
      hashedPassword,
      phone,
      age,
      address,
      wing,
      avatar || '',
      JSON.stringify(availability),
      digitalId,
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ error: 'Email already registered' })
          } else {
            res.status(500).json({ error: err.message })
          }
          return
        }
        const volunteerId = this.lastID
        
        // Add \"joined\" activity
        db.run(
          'INSERT INTO activities (volunteer_id, activity_type, description) VALUES (?, ?, ?)',
          [volunteerId, 'joined', 'Joined UYHO as a volunteer'],
          (actErr) => {
            if (actErr) console.error('Failed to create join activity:', actErr)
          }
        )
        
        res.json({
          id: volunteerId,
          fullName,
          email,
          digitalId,
          message: 'Registration successful! Your volunteer ID is ' + digitalId
        })
      }
    )
    stmt.finalize()
  })
})

// Volunteer login endpoint
app.post('/api/volunteers/login', (req, res) => {
  const { email, password } = req.body

  const hashedPassword = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex')

  db.get(
    'SELECT * FROM volunteers WHERE email = ? AND password = ?',
    [email, hashedPassword],
    (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message })
        return
      }

      if (!row) {
        res.status(401).json({ error: 'Invalid email or password' })
        return
      }

      // Don't send password back
      const { password: _, ...volunteer } = row
      const availabilityParsed = {
        ...volunteer,
        availability: JSON.parse(volunteer.availability || '[]')
      }

      res.json(availabilityParsed)
    }
  )
})

// Get all volunteers
app.get('/api/volunteers/all', (req, res) => {
  db.all(`
    SELECT id, full_name, email, phone, wing, position, avatar, digital_id, status, points, hours_given, lives_impacted
    FROM volunteers
    ORDER BY full_name
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows || []);
  });
});

// Get volunteer directory (for campaign team selection) - MUST be before /:id route
app.get('/api/volunteers/directory', (req, res) => {
  db.all(`
    SELECT id, full_name, wing, position, avatar, digital_id, status
    FROM volunteers
    WHERE status = 'Active'
    ORDER BY full_name
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows || []);
  });
});

// Get volunteer profile
app.get('/api/volunteers/:id', (req, res) => {
  const { id } = req.params
  db.get('SELECT * FROM volunteers WHERE id = ?', [id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!row) {
      res.status(404).json({ error: 'Volunteer not found' })
      return
    }
    const { password: _, ...volunteer } = row
    const availabilityParsed = {
      ...volunteer,
      availability: JSON.parse(volunteer.availability || '[]')
    }
    
    // Check if position is a central executive role
    db.get(`
      SELECT title, category 
      FROM organization_roles 
      WHERE LOWER(title) = LOWER(?)
    `, [row.position], (roleErr, roleRow) => {
      // Get wing memberships with parent wing info
      db.all(`
        SELECT wm.role as wing_role, wm.is_parent, w.id as wing_id, w.name as wing_name
        FROM wing_members wm
        JOIN wings w ON wm.wing_id = w.id
        WHERE wm.volunteer_id = ? AND w.approval_status = 'approved'
        ORDER BY wm.is_parent DESC, wm.joined_at ASC
      `, [id], (wingErr, wingRows) => {
        const isExecutive = roleRow?.category === 'executive';
        // Find parent wing (either is_parent=1 or first joined wing)
        const parentWing = wingRows?.find(w => w.is_parent === 1) || wingRows?.[0] || null;
        res.json({
          ...availabilityParsed,
          central_role: isExecutive ? roleRow?.title : null,
          central_category: isExecutive ? roleRow?.category : null,
          wings: wingRows || [],
          parent_wing: parentWing
        })
      })
    })
  })
})

// Get volunteer by email
app.get('/api/volunteers/email/:email', (req, res) => {
  const { email } = req.params
  db.get('SELECT * FROM volunteers WHERE email = ?', [email], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!row) {
      res.status(404).json({ error: 'Volunteer not found' })
      return
    }
    const { password: _, ...volunteer } = row
    const availabilityParsed = {
      ...volunteer,
      availability: JSON.parse(volunteer.availability || '[]')
    }
    res.json(availabilityParsed)
  })
})

// Get volunteer activities
app.get('/api/volunteers/:id/activities', (req, res) => {
  const { id } = req.params
  const { limit } = req.query
  
  let query = 'SELECT * FROM activities WHERE volunteer_id = ? ORDER BY created_at DESC'
  const params = [id]
  
  if (limit) {
    query += ' LIMIT ?'
    params.push(parseInt(limit))
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(rows || [])
  })
})

// Get volunteer's most recent joined campaign
app.get('/api/volunteers/:id/recent-campaign', (req, res) => {
  const { id } = req.params
  
  db.get(`
    SELECT c.*, ct.role, ct.hours, ct.respect, ct.approval_status,
           v.full_name as host_name, v.avatar as host_avatar
    FROM campaign_team ct
    JOIN campaigns c ON ct.campaign_id = c.id
    LEFT JOIN volunteers v ON c.host_id = v.id
    WHERE ct.volunteer_id = ? AND c.approval_status = 'approved'
    ORDER BY ct.created_at DESC
    LIMIT 1
  `, [id], (err, campaign) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!campaign) {
      res.status(404).json({ error: 'No recent campaign found' })
      return
    }
    res.json(campaign)
  })
})

// ========== ALLIES API ENDPOINTS ==========

// Add an ally
app.post('/api/allies', (req, res) => {
  const { volunteerId, allyId } = req.body
  
  if (!volunteerId || !allyId) {
    return res.status(400).json({ error: 'volunteerId and allyId are required' })
  }
  
  if (volunteerId === allyId) {
    return res.status(400).json({ error: 'Cannot add yourself as an ally' })
  }
  
  db.run(
    'INSERT OR IGNORE INTO allies (volunteer_id, ally_id) VALUES (?, ?)',
    [volunteerId, allyId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      
      // Notify the person being added as ally
      if (this.lastID) {
        db.get('SELECT full_name, avatar FROM volunteers WHERE id = ?', [volunteerId], (err, actor) => {
          if (!err && actor) {
            createNotification(allyId, 'ally_added',
              `${actor.full_name} added you as an ally!`, {
                data: { userId: parseInt(volunteerId) },
                actorId: parseInt(volunteerId),
                actorName: actor.full_name,
                actorAvatar: actor.avatar,
                priority: 'normal'
            }).catch(console.error);
          }
        });
      }
      
      res.json({ success: true, id: this.lastID })
    }
  )
})

// Get all allies for a volunteer
app.get('/api/allies/:volunteerId', (req, res) => {
  const { volunteerId } = req.params
  
  db.all(
    `SELECT v.id, v.full_name, v.avatar, v.wing, v.position, a.created_at as allied_at
     FROM allies a 
     JOIN volunteers v ON a.ally_id = v.id 
     WHERE a.volunteer_id = ?
     ORDER BY a.created_at DESC`,
    [volunteerId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// Get ally count for a volunteer
app.get('/api/allies/:volunteerId/count', (req, res) => {
  const { volunteerId } = req.params
  
  db.get(
    'SELECT COUNT(*) as count FROM allies WHERE volunteer_id = ?',
    [volunteerId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ count: row?.count || 0 })
    }
  )
})

// Check if someone is an ally
app.get('/api/allies/check/:volunteerId/:allyId', (req, res) => {
  const { volunteerId, allyId } = req.params
  
  db.get(
    'SELECT id FROM allies WHERE volunteer_id = ? AND ally_id = ?',
    [volunteerId, allyId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ isAlly: !!row })
    }
  )
})

// Remove an ally
app.delete('/api/allies/:volunteerId/:allyId', (req, res) => {
  const { volunteerId, allyId } = req.params
  
  db.run(
    'DELETE FROM allies WHERE volunteer_id = ? AND ally_id = ?',
    [volunteerId, allyId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true, deleted: this.changes > 0 })
    }
  )
})

// Get ally IDs for a volunteer (for quick lookup)
app.get('/api/allies/:volunteerId/ids', (req, res) => {
  const { volunteerId } = req.params
  
  db.all(
    'SELECT ally_id FROM allies WHERE volunteer_id = ?',
    [volunteerId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows?.map(r => r.ally_id) || [])
    }
  )
})

// ========== PRIVACY SETTINGS API ENDPOINTS ==========

// Get privacy settings for a user
app.get('/api/privacy/:userId', (req, res) => {
  const { userId } = req.params
  
  db.get(
    'SELECT * FROM privacy_settings WHERE user_id = ?',
    [userId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      // Return default settings if none exist
      res.json(row || { allies_visibility: 'public' })
    }
  )
})

// Update privacy settings
app.put('/api/privacy/:userId', (req, res) => {
  const { userId } = req.params
  const { allies_visibility } = req.body
  
  // Validate visibility value
  const validOptions = ['public', 'allies', 'none']
  if (allies_visibility && !validOptions.includes(allies_visibility)) {
    return res.status(400).json({ error: 'Invalid visibility option' })
  }
  
  // Upsert privacy settings
  db.run(
    `INSERT INTO privacy_settings (user_id, allies_visibility, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
     allies_visibility = COALESCE(excluded.allies_visibility, allies_visibility),
     updated_at = CURRENT_TIMESTAMP`,
    [userId, allies_visibility || 'public'],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true })
    }
  )
})

// Get allies visibility for a specific user (for privacy check)
app.get('/api/privacy/:userId/allies-visibility', (req, res) => {
  const { userId } = req.params
  
  db.get(
    'SELECT allies_visibility FROM privacy_settings WHERE user_id = ?',
    [userId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ visibility: row?.allies_visibility || 'public' })
    }
  )
})

// ========== ORGANIZATION SETTINGS API ENDPOINTS ==========

// Get organization settings
app.get('/api/organization', (req, res) => {
  db.get('SELECT * FROM organization_settings LIMIT 1', (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(row || {
      org_name: 'UYHO',
      org_full_name: 'United Young Help Organization',
      org_description: 'A youth-led nonprofit organization dedicated to community service.'
    })
  })
})

// Update organization settings
app.put('/api/organization', (req, res) => {
  const {
    org_name, org_full_name, org_description, org_logo, org_logo_dark,
    contact_email, contact_phone, contact_address, website_url,
    facebook_url, instagram_url, twitter_url, linkedin_url, youtube_url, tiktok_url
  } = req.body
  
  db.run(`
    UPDATE organization_settings SET
      org_name = COALESCE(?, org_name),
      org_full_name = COALESCE(?, org_full_name),
      org_description = COALESCE(?, org_description),
      org_logo = COALESCE(?, org_logo),
      org_logo_dark = COALESCE(?, org_logo_dark),
      contact_email = COALESCE(?, contact_email),
      contact_phone = COALESCE(?, contact_phone),
      contact_address = COALESCE(?, contact_address),
      website_url = COALESCE(?, website_url),
      facebook_url = COALESCE(?, facebook_url),
      instagram_url = COALESCE(?, instagram_url),
      twitter_url = COALESCE(?, twitter_url),
      linkedin_url = COALESCE(?, linkedin_url),
      youtube_url = COALESCE(?, youtube_url),
      tiktok_url = COALESCE(?, tiktok_url),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [
    org_name, org_full_name, org_description, org_logo, org_logo_dark,
    contact_email, contact_phone, contact_address, website_url,
    facebook_url, instagram_url, twitter_url, linkedin_url, youtube_url, tiktok_url
  ], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true })
  })
})

// Add a social media link
app.post('/api/organization/social-link', (req, res) => {
  const { platform, url } = req.body
  
  const validPlatforms = ['facebook_url', 'instagram_url', 'twitter_url', 'linkedin_url', 'youtube_url', 'tiktok_url']
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' })
  }
  
  db.run(`UPDATE organization_settings SET ${platform} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [url], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true })
  })
})

// ========== ORGANIZATION ROLES API ENDPOINTS ==========

// Get all roles
app.get('/api/roles', (req, res) => {
  db.all('SELECT * FROM organization_roles ORDER BY category, sort_order', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(rows || [])
  })
})

// Get roles by category
app.get('/api/roles/:category', (req, res) => {
  const { category } = req.params
  db.all('SELECT * FROM organization_roles WHERE category = ? ORDER BY sort_order', [category], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(rows || [])
  })
})

// Update a role
app.put('/api/roles/:id', (req, res) => {
  const { id } = req.params
  const { title, description } = req.body
  
  db.run(
    'UPDATE organization_roles SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [title, description, id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true })
    }
  )
})

// Add a new role
app.post('/api/roles', (req, res) => {
  const { title, description, category } = req.body
  
  if (!title || !category) {
    return res.status(400).json({ error: 'Title and category are required' })
  }
  
  // Get max sort_order for the category
  db.get('SELECT MAX(sort_order) as max_order FROM organization_roles WHERE category = ?', [category], (err, row) => {
    const newOrder = (row?.max_order || 0) + 1
    
    db.run(
      'INSERT INTO organization_roles (title, description, category, sort_order) VALUES (?, ?, ?, ?)',
      [title, description || '', category, newOrder],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message })
        }
        res.json({ success: true, id: this.lastID })
      }
    )
  })
})

// Delete a role
app.delete('/api/roles/:id', (req, res) => {
  const { id } = req.params
  
  db.run('DELETE FROM organization_roles WHERE id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true, deleted: this.changes > 0 })
  })
})

// ========== MESSAGING API ENDPOINTS ==========

// Get or create a conversation between two users
app.post('/api/conversations', (req, res) => {
  const { userId1, userId2 } = req.body
  
  if (!userId1 || !userId2) {
    return res.status(400).json({ error: 'Both user IDs are required' })
  }
  
  // Always store with smaller ID first to ensure uniqueness
  const p1 = Math.min(userId1, userId2)
  const p2 = Math.max(userId1, userId2)
  
  // Check if conversation exists
  db.get(
    'SELECT * FROM conversations WHERE participant1_id = ? AND participant2_id = ?',
    [p1, p2],
    (err, existing) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      
      if (existing) {
        return res.json(existing)
      }
      
      // Create new conversation
      db.run(
        'INSERT INTO conversations (participant1_id, participant2_id) VALUES (?, ?)',
        [p1, p2],
        function(insertErr) {
          if (insertErr) {
            return res.status(500).json({ error: insertErr.message })
          }
          res.json({ id: this.lastID, participant1_id: p1, participant2_id: p2 })
        }
      )
    }
  )
})

// Get all conversations for a user
app.get('/api/conversations/:userId', (req, res) => {
  const { userId } = req.params
  
  db.all(
    `SELECT c.*, 
      CASE WHEN c.participant1_id = ? THEN v2.id ELSE v1.id END as other_user_id,
      CASE WHEN c.participant1_id = ? THEN v2.full_name ELSE v1.full_name END as other_user_name,
      CASE WHEN c.participant1_id = ? THEN v2.avatar ELSE v1.avatar END as other_user_avatar,
      CASE WHEN c.participant1_id = ? THEN v2.wing ELSE v1.wing END as other_user_wing,
      m.content as last_message_content,
      m.message_type as last_message_type,
      m.created_at as last_message_time,
      m.sender_id as last_message_sender,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) as unread_count
     FROM conversations c
     JOIN volunteers v1 ON c.participant1_id = v1.id
     JOIN volunteers v2 ON c.participant2_id = v2.id
     LEFT JOIN messages m ON c.last_message_id = m.id
     WHERE c.participant1_id = ? OR c.participant2_id = ?
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`,
    [userId, userId, userId, userId, userId, userId, userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// Get messages for a conversation with pagination
app.get('/api/conversations/:conversationId/messages', (req, res) => {
  const { conversationId } = req.params
  const { limit = 15, before, userId } = req.query
  
  // Update last_active for the user if provided
  if (userId) {
    db.run('UPDATE volunteers SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [userId])
  }
  
  // Get other participant info for seen avatar
  db.get(`
    SELECT 
      CASE WHEN participant1_id = ? THEN participant2_id ELSE participant1_id END as other_user_id
    FROM conversations WHERE id = ?
  `, [userId || 0, conversationId], (err, conv) => {
    const otherUserId = conv?.other_user_id
    
    let query = `
      SELECT m.*, v.full_name as sender_name, v.avatar as sender_avatar
      FROM messages m
      JOIN volunteers v ON m.sender_id = v.id
      WHERE m.conversation_id = ?
    `
    const params = [conversationId]
    
    if (before) {
      query += ' AND m.id < ?'
      params.push(before)
    }
    
    query += ' ORDER BY m.created_at DESC LIMIT ?'
    params.push(parseInt(limit))
    
    db.all(query, params, (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      
      // Check if there are more messages
      const oldestId = rows?.length > 0 ? rows[rows.length - 1].id : null
      db.get('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND id < ?', 
        [conversationId, oldestId || 0], 
        (countErr, countRow) => {
          const hasMore = (countRow?.count || 0) > 0
          
          // Get the other user's avatar for seen indicator
          db.get('SELECT avatar, full_name FROM volunteers WHERE id = ?', [otherUserId], (avatarErr, otherUser) => {
            res.json({
              messages: (rows || []).reverse(),
              hasMore,
              oldestId,
              otherUserAvatar: otherUser?.avatar,
              otherUserName: otherUser?.full_name
            })
          })
        }
      )
    })
  })
})

// Send a message
app.post('/api/messages', (req, res) => {
  const { conversationId, senderId, content, messageType = 'text', fileUrl, fileName, fileSize } = req.body
  
  if (!conversationId || !senderId) {
    return res.status(400).json({ error: 'conversationId and senderId are required' })
  }
  
  if (messageType === 'text' && !content) {
    return res.status(400).json({ error: 'Content is required for text messages' })
  }
  
  db.run(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type, file_url, file_name, file_size)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, senderId, content, messageType, fileUrl, fileName, fileSize],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      
      const messageId = this.lastID
      
      // Update conversation's last message
      db.run(
        'UPDATE conversations SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
        [messageId, conversationId]
      )
      
      // Get recipient and send notification
      db.get(`
        SELECT c.user1_id, c.user2_id, v.full_name as sender_name, v.avatar as sender_avatar
        FROM conversations c
        JOIN volunteers v ON v.id = ?
        WHERE c.id = ?
      `, [senderId, conversationId], (convErr, convData) => {
        if (!convErr && convData) {
          const recipientId = convData.user1_id == senderId ? convData.user2_id : convData.user1_id;
          const notifType = messageType === 'image' ? 'message_image' : 'message';
          const preview = messageType === 'text' ? (content.length > 50 ? content.slice(0, 50) + '...' : content) : (messageType === 'image' ? 'Sent an image' : 'Sent a file');
          
          createNotification(recipientId, notifType, `sent you a message`, {
            data: { 
              senderId: parseInt(senderId), 
              conversationId: parseInt(conversationId),
              preview 
            },
            actorId: parseInt(senderId),
            actorName: convData.sender_name,
            actorAvatar: convData.sender_avatar,
            priority: 'normal'
          }).catch(console.error);
        }
      });
      
      // Return the created message with sender info
      db.get(
        `SELECT m.*, v.full_name as sender_name, v.avatar as sender_avatar
         FROM messages m
         JOIN volunteers v ON m.sender_id = v.id
         WHERE m.id = ?`,
        [messageId],
        (getErr, message) => {
          if (getErr) {
            return res.status(500).json({ error: getErr.message })
          }
          res.json(message)
        }
      )
    }
  )
})

// Mark messages as read
app.put('/api/conversations/:conversationId/read', (req, res) => {
  const { conversationId } = req.params
  const { userId } = req.body
  
  // Update last_active for the user
  db.run('UPDATE volunteers SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [userId])
  
  db.run(
    `UPDATE messages SET is_read = 1, status = 'read', read_at = CURRENT_TIMESTAMP 
     WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`,
    [conversationId, userId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true, updated: this.changes })
    }
  )
})

// Get unread message count for a user
app.get('/api/messages/unread/:userId', (req, res) => {
  const { userId } = req.params
  
  db.get(
    `SELECT COUNT(*) as count FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE (c.participant1_id = ? OR c.participant2_id = ?)
     AND m.sender_id != ? AND m.is_read = 0`,
    [userId, userId, userId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ count: row?.count || 0 })
    }
  )
})

// Update user's last_active (heartbeat)
app.post('/api/volunteers/:userId/heartbeat', (req, res) => {
  const { userId } = req.params
  db.run('UPDATE volunteers SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [userId], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true })
  })
})

// Get user's online status
app.get('/api/volunteers/:userId/status', (req, res) => {
  const { userId } = req.params
  db.get('SELECT last_active FROM volunteers WHERE id = ?', [userId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    if (!row) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    const lastActive = row.last_active ? new Date(row.last_active) : null
    const now = new Date()
    const diffMs = lastActive ? now - lastActive : Infinity
    const isOnline = diffMs < 60000 // Consider online if active within last 60 seconds
    const isRecent = diffMs < 300000 // Active within last 5 minutes
    
    let statusText = 'offline'
    if (isOnline) {
      statusText = 'Active now'
    } else if (isRecent) {
      const mins = Math.floor(diffMs / 60000)
      statusText = `Active ${mins}m ago`
    } else if (lastActive) {
      const hours = Math.floor(diffMs / 3600000)
      if (hours < 24) {
        statusText = `Active ${hours}h ago`
      } else {
        statusText = `Active ${Math.floor(hours / 24)}d ago`
      }
    }
    
    res.json({ 
      isOnline,
      isRecent,
      statusText,
      lastActive: row.last_active
    })
  })
})

// Mark messages as delivered when user opens conversation
app.put('/api/conversations/:conversationId/delivered', (req, res) => {
  const { conversationId } = req.params
  const { userId } = req.body
  
  db.run(
    `UPDATE messages SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END, 
     delivered_at = CASE WHEN delivered_at IS NULL THEN CURRENT_TIMESTAMP ELSE delivered_at END
     WHERE conversation_id = ? AND sender_id != ? AND status = 'sent'`,
    [conversationId, userId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true, updated: this.changes })
    }
  )
})

// Typing indicator endpoints
// Store typing users temporarily in memory: { conversationId: Set(userIds), groupId: Set(userIds) }
const typingUsers = {};

// Broadcast typing status for individual conversation
app.post('/api/conversations/:conversationId/typing', (req, res) => {
  const { conversationId } = req.params;
  const { volunteerId, isTyping } = req.body;
  
  if (!conversationId || !volunteerId) {
    return res.status(400).json({ error: 'conversationId and volunteerId are required' });
  }
  
  if (!typingUsers[conversationId]) {
    typingUsers[conversationId] = new Set();
  }
  
  if (isTyping) {
    typingUsers[conversationId].add(parseInt(volunteerId));
    // Auto-remove after 5 seconds of inactivity
    setTimeout(() => {
      typingUsers[conversationId].delete(parseInt(volunteerId));
      if (typingUsers[conversationId].size === 0) {
        delete typingUsers[conversationId];
      }
    }, 5000);
  } else {
    typingUsers[conversationId].delete(parseInt(volunteerId));
    if (typingUsers[conversationId].size === 0) {
      delete typingUsers[conversationId];
    }
  }
  
  res.json({ success: true });
});

// Get typing users for a conversation
app.get('/api/conversations/:conversationId/typing', (req, res) => {
  const { conversationId } = req.params;
  const typingList = Array.from(typingUsers[conversationId] || []);
  res.json({ typingUsers: typingList });
});

// Broadcast typing status for group chat
app.post('/api/groups/:groupId/typing', (req, res) => {
  const { groupId } = req.params;
  const { volunteerId, isTyping } = req.body;
  
  if (!groupId || !volunteerId) {
    return res.status(400).json({ error: 'groupId and volunteerId are required' });
  }
  
  const key = `group_${groupId}`;
  if (!typingUsers[key]) {
    typingUsers[key] = new Set();
  }
  
  if (isTyping) {
    typingUsers[key].add(parseInt(volunteerId));
    // Auto-remove after 5 seconds of inactivity
    setTimeout(() => {
      typingUsers[key].delete(parseInt(volunteerId));
      if (typingUsers[key].size === 0) {
        delete typingUsers[key];
      }
    }, 5000);
  } else {
    typingUsers[key].delete(parseInt(volunteerId));
    if (typingUsers[key].size === 0) {
      delete typingUsers[key];
    }
  }
  
  res.json({ success: true });
});

// Get typing users for a group - includes user names
app.get('/api/groups/:groupId/typing', (req, res) => {
  const { groupId } = req.params;
  const key = `group_${groupId}`;
  const typingList = Array.from(typingUsers[key] || []);
  
  if (typingList.length === 0) {
    return res.json({ typingUsers: [], typingUserNames: [] });
  }
  
  // Get names for typing users
  const placeholders = typingList.map(() => '?').join(',');
  db.all(
    `SELECT id, full_name FROM volunteers WHERE id IN (${placeholders})`,
    typingList,
    (err, users) => {
      if (err) {
        return res.json({ typingUsers: typingList, typingUserNames: [] });
      }
      const names = typingList.map(id => {
        const user = users.find(u => u.id === id);
        return user ? user.full_name?.split(' ')[0] : 'Someone';
      });
      res.json({ typingUsers: typingList, typingUserNames: names });
    }
  );
});

// Get active members in a group (recently online)
app.get('/api/groups/:groupId/active-members', (req, res) => {
  const { groupId } = req.params;
  
  db.all(`
    SELECT v.id, v.full_name, v.avatar, v.last_active
    FROM volunteers v
    JOIN group_members gm ON v.id = gm.user_id
    WHERE gm.group_id = ?
    AND v.last_active > datetime('now', '-5 minutes')
    ORDER BY v.last_active DESC
  `, [groupId], (err, members) => {
    if (err) {
      return res.json([]);
    }
    res.json(members || []);
  });
});

// ==================== GROUP CHAT API ====================

// Helper function to add system message to group
const addGroupSystemMessage = (groupId, content) => {
  return new Promise((resolve, reject) => {
    // Use creator_id as sender for system messages (or any existing member)
    db.get('SELECT creator_id FROM group_chats WHERE id = ?', [groupId], (err, group) => {
      if (err || !group) return reject(err)
      
      db.run(
        `INSERT INTO messages (conversation_id, group_id, sender_id, content, message_type) VALUES (NULL, ?, ?, ?, 'system')`,
        [groupId, group.creator_id, content],
        function(insertErr) {
          if (insertErr) return reject(insertErr)
          
          // Update group's last message
          db.run(
            'UPDATE group_chats SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
            [this.lastID, groupId]
          )
          resolve(this.lastID)
        }
      )
    })
  })
}

// Create a new group chat
app.post('/api/groups', (req, res) => {
  const { name, description, avatar, creatorId, memberIds, allowMemberAdd } = req.body
  
  if (!name || !creatorId || !memberIds || memberIds.length < 2) {
    return res.status(400).json({ error: 'Group name, creator, and at least 2 members are required' })
  }
  
  // Get creator name for system message
  db.get('SELECT full_name FROM volunteers WHERE id = ?', [creatorId], (nameErr, creator) => {
    if (nameErr) return res.status(500).json({ error: nameErr.message })
    
    db.run(
      'INSERT INTO group_chats (name, description, avatar, creator_id, allow_member_add) VALUES (?, ?, ?, ?, ?)',
      [name, description || '', avatar || '', creatorId, allowMemberAdd ? 1 : 0],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message })
        }
        
        const groupId = this.lastID
        
        // Add creator as admin
        const allMembers = [creatorId, ...memberIds.filter(id => id !== creatorId)]
        const insertStmt = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, ?)')
        
        allMembers.forEach((memberId, index) => {
          insertStmt.run(groupId, memberId, memberId === creatorId ? 1 : 0)
        })
        
        insertStmt.finalize()
        
        // Add system message for group creation
        addGroupSystemMessage(groupId, `${creator?.full_name || 'Someone'} created the group "${name}"`)
          .then(() => {
            res.json({ id: groupId, name, description, avatar, creatorId })
          })
          .catch(() => {
            res.json({ id: groupId, name, description, avatar, creatorId })
          })
      }
    )
  })
})

// Get all groups for a user
app.get('/api/groups/user/:userId', (req, res) => {
  const { userId } = req.params
  
  db.all(
    `SELECT g.*, 
            (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
            gm.is_admin,
            (SELECT content FROM messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_content,
            (SELECT message_type FROM messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_type,
            (SELECT created_at FROM messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
            (SELECT sender_id FROM messages WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1) as last_message_sender_id,
            (SELECT v.full_name FROM messages m LEFT JOIN volunteers v ON m.sender_id = v.id WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1) as last_message_sender_name,
            (SELECT COUNT(*) FROM messages WHERE group_id = g.id AND sender_id != ? AND is_read = 0) as unread_count
     FROM group_chats g
     JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.user_id = ?
     ORDER BY COALESCE(g.last_message_at, g.created_at) DESC`,
    [userId, userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// Get group details with members
app.get('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params
  
  db.get('SELECT * FROM group_chats WHERE id = ?', [groupId], (err, group) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    if (!group) {
      return res.status(404).json({ error: 'Group not found' })
    }
    
    db.all(
      `SELECT gm.*, v.full_name, v.avatar, v.wing, v.position
       FROM group_members gm
       JOIN volunteers v ON gm.user_id = v.id
       WHERE gm.group_id = ?
       ORDER BY gm.is_admin DESC, gm.joined_at ASC`,
      [groupId],
      (membersErr, members) => {
        if (membersErr) {
          return res.status(500).json({ error: membersErr.message })
        }
        res.json({ ...group, members: members || [] })
      }
    )
  })
})

// Get group messages
app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params
  
  db.all(
    `SELECT m.*, v.full_name as sender_name, v.avatar as sender_avatar
     FROM messages m
     LEFT JOIN volunteers v ON m.sender_id = v.id
     WHERE m.group_id = ?
     ORDER BY m.created_at ASC`,
    [groupId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// Send message to group
app.post('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params
  const { senderId, content, messageType = 'text', fileUrl, fileName, fileSize } = req.body
  
  if (!senderId) {
    return res.status(400).json({ error: 'senderId is required' })
  }
  
  db.run(
    `INSERT INTO messages (conversation_id, group_id, sender_id, content, message_type, file_url, file_name, file_size)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [groupId, senderId, content, messageType, fileUrl, fileName, fileSize],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      
      const messageId = this.lastID
      
      // Update group's last message
      db.run(
        'UPDATE group_chats SET last_message_id = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
        [messageId, groupId]
      )
      
      // Return the created message with sender info
      db.get(
        `SELECT m.*, v.full_name as sender_name, v.avatar as sender_avatar
         FROM messages m
         JOIN volunteers v ON m.sender_id = v.id
         WHERE m.id = ?`,
        [messageId],
        (getErr, message) => {
          if (getErr) {
            return res.status(500).json({ error: getErr.message })
          }
          res.json(message)
        }
      )
    }
  )
})

// Update group details (for admins)
app.put('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params
  const { userId, name, description, avatar, allowMemberAdd } = req.body
  
  // Check if user is admin
  db.get(
    'SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?',
    [groupId, userId],
    (err, member) => {
      if (err || !member || !member.is_admin) {
        return res.status(403).json({ error: 'Only admins can update group' })
      }
      
      const updates = []
      const params = []
      
      if (name) { updates.push('name = ?'); params.push(name) }
      if (description !== undefined) { updates.push('description = ?'); params.push(description) }
      if (avatar !== undefined) { updates.push('avatar = ?'); params.push(avatar) }
      if (allowMemberAdd !== undefined) { updates.push('allow_member_add = ?'); params.push(allowMemberAdd ? 1 : 0) }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No updates provided' })
      }
      
      params.push(groupId)
      
      db.run(
        `UPDATE group_chats SET ${updates.join(', ')} WHERE id = ?`,
        params,
        function(updateErr) {
          if (updateErr) {
            return res.status(500).json({ error: updateErr.message })
          }
          res.json({ success: true })
        }
      )
    }
  )
})

// Add member to group
app.post('/api/groups/:groupId/members', (req, res) => {
  const { groupId } = req.params
  const { userId, addedBy } = req.body
  
  // Check if adder has permission
  db.get(
    `SELECT g.allow_member_add, g.creator_id, gm.is_admin 
     FROM group_chats g
     JOIN group_members gm ON g.id = gm.group_id
     WHERE g.id = ? AND gm.user_id = ?`,
    [groupId, addedBy],
    (err, result) => {
      if (err || !result) {
        return res.status(403).json({ error: 'Not authorized to add members' })
      }
      
      // Check if user can add (is admin or group allows member add)
      if (!result.is_admin && !result.allow_member_add) {
        return res.status(403).json({ error: 'Only admins can add members to this group' })
      }
      
      // Get names for system message
      db.get('SELECT full_name FROM volunteers WHERE id = ?', [userId], (userErr, newMember) => {
        db.get('SELECT full_name FROM volunteers WHERE id = ?', [addedBy], (adderErr, adder) => {
          db.run(
            'INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)',
            [groupId, userId],
            function(insertErr) {
              if (insertErr) {
                return res.status(500).json({ error: insertErr.message })
              }
              
              // Add system message
              addGroupSystemMessage(groupId, `${adder?.full_name || 'Someone'} added ${newMember?.full_name || 'a new member'}`)
              
              res.json({ success: true })
            }
          )
        })
      })
    }
  )
})

// Remove member from group
app.delete('/api/groups/:groupId/members/:memberId', (req, res) => {
  const { groupId, memberId } = req.params
  const { removedBy } = req.body
  
  // Check if remover is admin and member is not creator
  db.get(
    `SELECT g.creator_id, gm.is_admin 
     FROM group_chats g
     JOIN group_members gm ON g.id = gm.group_id
     WHERE g.id = ? AND gm.user_id = ?`,
    [groupId, removedBy],
    (err, result) => {
      if (err || !result || !result.is_admin) {
        return res.status(403).json({ error: 'Only admins can remove members' })
      }
      
      // Cannot remove creator
      if (parseInt(memberId) === result.creator_id) {
        return res.status(403).json({ error: 'Cannot remove group creator' })
      }
      
      // Get member name for system message
      db.get('SELECT full_name FROM volunteers WHERE id = ?', [memberId], (nameErr, member) => {
        db.run(
          'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
          [groupId, memberId],
          function(deleteErr) {
            if (deleteErr) {
              return res.status(500).json({ error: deleteErr.message })
            }
            
            // Add system message
            addGroupSystemMessage(groupId, `${member?.full_name || 'Someone'} was removed from the group`)
            
            res.json({ success: true })
          }
        )
      })
    }
  )
})

// Toggle admin status (only creator can do this)
app.put('/api/groups/:groupId/members/:memberId/admin', (req, res) => {
  const { groupId, memberId } = req.params
  const { changedBy, isAdmin } = req.body
  
  // Check if changer is creator
  db.get('SELECT creator_id FROM group_chats WHERE id = ?', [groupId], (err, group) => {
    if (err || !group) {
      return res.status(404).json({ error: 'Group not found' })
    }
    
    if (parseInt(changedBy) !== group.creator_id) {
      return res.status(403).json({ error: 'Only group creator can manage admins' })
    }
    
    // Cannot change creator's admin status
    if (parseInt(memberId) === group.creator_id) {
      return res.status(403).json({ error: 'Cannot change creator admin status' })
    }
    
    // Get member name for system message
    db.get('SELECT full_name FROM volunteers WHERE id = ?', [memberId], (nameErr, member) => {
      db.run(
        'UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?',
        [isAdmin ? 1 : 0, groupId, memberId],
        function(updateErr) {
          if (updateErr) {
            return res.status(500).json({ error: updateErr.message })
          }
          
          // Add system message
          const action = isAdmin ? 'is now an admin' : 'is no longer an admin'
          addGroupSystemMessage(groupId, `${member?.full_name || 'Someone'} ${action}`)
          
          res.json({ success: true })
        }
      )
    })
  })
})

// Mark group messages as read
app.put('/api/groups/:groupId/read', (req, res) => {
  const { groupId } = req.params
  const { userId } = req.body
  
  db.run(
    'UPDATE messages SET is_read = 1 WHERE group_id = ? AND sender_id != ? AND is_read = 0',
    [groupId, userId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true, updated: this.changes })
    }
  )
})

// Leave group
app.delete('/api/groups/:groupId/leave/:userId', (req, res) => {
  const { groupId, userId } = req.params
  
  // Check if user is creator
  db.get('SELECT * FROM group_chats WHERE id = ?', [groupId], (err, group) => {
    if (err || !group) {
      return res.status(404).json({ error: 'Group not found' })
    }
    
    if (parseInt(userId) === group.creator_id) {
      return res.status(403).json({ error: 'Creator cannot leave the group. Delete the group instead.' })
    }
    
    // Get user name for system message and activity
    db.get('SELECT full_name FROM volunteers WHERE id = ?', [userId], (nameErr, member) => {
      db.run(
        'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
        [groupId, userId],
        function(deleteErr) {
          if (deleteErr) {
            return res.status(500).json({ error: deleteErr.message })
          }
          
          // Also remove from pinned if pinned
          db.run('DELETE FROM pinned_chats WHERE user_id = ? AND group_id = ?', [userId, groupId])
          
          // Also remove from muted if muted
          db.run('DELETE FROM muted_chats WHERE user_id = ? AND group_id = ?', [userId, groupId])
          
          // Add system message
          addGroupSystemMessage(groupId, `${member?.full_name || 'Someone'} left the group`)
          
          // Add activity for leaving group
          db.run(
            'INSERT INTO activities (volunteer_id, activity_type, description) VALUES (?, ?, ?)',
            [userId, 'left_group', `Left group "${group.name}"`]
          )
          
          res.json({ success: true })
        }
      )
    })
  })
})

// ==================== PINNED CHATS API ====================

// Pin a chat
app.post('/api/pinned', (req, res) => {
  const { userId, conversationId, groupId } = req.body
  
  if (!userId || (!conversationId && !groupId)) {
    return res.status(400).json({ error: 'userId and either conversationId or groupId required' })
  }
  
  const query = conversationId 
    ? 'INSERT OR REPLACE INTO pinned_chats (user_id, conversation_id) VALUES (?, ?)'
    : 'INSERT OR REPLACE INTO pinned_chats (user_id, group_id) VALUES (?, ?)'
  const params = conversationId ? [userId, conversationId] : [userId, groupId]
  
  db.run(query, params, function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true, id: this.lastID })
  })
})

// Unpin a chat
app.delete('/api/pinned', (req, res) => {
  const { userId, conversationId, groupId } = req.body
  
  const query = conversationId 
    ? 'DELETE FROM pinned_chats WHERE user_id = ? AND conversation_id = ?'
    : 'DELETE FROM pinned_chats WHERE user_id = ? AND group_id = ?'
  const params = conversationId ? [userId, conversationId] : [userId, groupId]
  
  db.run(query, params, function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true })
  })
})

// Get all pinned chats for a user
app.get('/api/pinned/:userId', (req, res) => {
  const { userId } = req.params
  
  db.all(
    `SELECT p.*, 
            c.participant1_id, c.participant2_id,
            g.name as group_name, g.avatar as group_avatar,
            CASE 
              WHEN c.id IS NOT NULL THEN 'conversation'
              ELSE 'group'
            END as chat_type
     FROM pinned_chats p
     LEFT JOIN conversations c ON p.conversation_id = c.id
     LEFT JOIN group_chats g ON p.group_id = g.id
     WHERE p.user_id = ?
     ORDER BY p.pinned_at DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// ==================== MUTED CHATS API ====================

// Mute a chat
app.post('/api/muted', (req, res) => {
  const { userId, conversationId, groupId } = req.body
  
  if (!userId || (!conversationId && !groupId)) {
    return res.status(400).json({ error: 'userId and either conversationId or groupId required' })
  }
  
  const query = conversationId 
    ? 'INSERT OR REPLACE INTO muted_chats (user_id, conversation_id) VALUES (?, ?)'
    : 'INSERT OR REPLACE INTO muted_chats (user_id, group_id) VALUES (?, ?)'
  const params = conversationId ? [userId, conversationId] : [userId, groupId]
  
  db.run(query, params, function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true, id: this.lastID })
  })
})

// Unmute a chat
app.delete('/api/muted', (req, res) => {
  const { userId, conversationId, groupId } = req.body
  
  const query = conversationId 
    ? 'DELETE FROM muted_chats WHERE user_id = ? AND conversation_id = ?'
    : 'DELETE FROM muted_chats WHERE user_id = ? AND group_id = ?'
  const params = conversationId ? [userId, conversationId] : [userId, groupId]
  
  db.run(query, params, function(err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ success: true })
  })
})

// Get all muted chats for a user
app.get('/api/muted/:userId', (req, res) => {
  const { userId } = req.params
  
  db.all(
    'SELECT * FROM muted_chats WHERE user_id = ?',
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// ==================== BLOCKED USERS API ====================

// Block a user
app.post('/api/blocked', (req, res) => {
  const { userId, blockedUserId } = req.body
  
  if (!userId || !blockedUserId) {
    return res.status(400).json({ error: 'userId and blockedUserId are required' })
  }
  
  db.run(
    'INSERT OR REPLACE INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)',
    [userId, blockedUserId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true, id: this.lastID })
    }
  )
})

// Unblock a user
app.delete('/api/blocked', (req, res) => {
  const { userId, blockedUserId } = req.body
  
  db.run(
    'DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?',
    [userId, blockedUserId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json({ success: true })
    }
  )
})

// Get all blocked users for a user
app.get('/api/blocked/:userId', (req, res) => {
  const { userId } = req.params
  
  db.all(
    `SELECT b.*, v.full_name, v.avatar 
     FROM blocked_users b
     JOIN volunteers v ON b.blocked_user_id = v.id
     WHERE b.user_id = ?`,
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      res.json(rows || [])
    }
  )
})

// Upload avatar for groups or general use
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'avatars')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      const ext = path.extname(file.originalname)
      cb(null, `group_${uniqueSuffix}${ext}`)
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
})

app.post('/api/upload-avatar', avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' })
  }
  
  const avatarUrl = `/avatars/${req.file.filename}`
  res.json({ avatarUrl })
})

// Upload file for chat (images, videos, files)
const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'chat-files')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      const ext = path.extname(file.originalname)
      cb(null, `chat_${uniqueSuffix}${ext}`)
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
})

// Upload images for wing posts
const postImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'post-images')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      const ext = path.extname(file.originalname)
      cb(null, `post_${uniqueSuffix}${ext}`)
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per image
})

// Upload single post image
app.post('/api/posts/upload-image', postImageUpload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' })
  }
  
  const imageUrl = `/post-images/${req.file.filename}`
  res.json({ imageUrl })
})

// Upload course slides (PowerPoint/PDF)
const courseSlideUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'public', 'course-slides')
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      const ext = path.extname(file.originalname)
      cb(null, `slide_${uniqueSuffix}${ext}`)
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/pdf'
    ]
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(ppt|pptx|pdf)$/i)) {
      cb(null, true)
    } else {
      cb(new Error('Invalid file type. Only PowerPoint and PDF files are allowed.'))
    }
  }
})

app.post('/api/upload', courseSlideUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' })
  }
  
  const filePath = `/course-slides/${req.file.filename}`
  res.json({ 
    filePath,
    fileName: req.file.originalname,
    fileSize: req.file.size
  })
})

// Get slide count and info from PPT file
app.get('/api/slides/info', async (req, res) => {
  const { file } = req.query
  if (!file) {
    return res.status(400).json({ error: 'File path required' })
  }
  
  const filePath = path.join(__dirname, 'public', file)
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' })
  }
  
  try {
    // For PPTX files, we can extract slide count from the ZIP structure
    if (file.match(/\.pptx$/i)) {
      const JSZip = (await import('jszip')).default
      const data = fs.readFileSync(filePath)
      const zip = await JSZip.loadAsync(data)
      
      // Count slides by looking for slide XML files
      let slideCount = 0
      zip.folder('ppt/slides')?.forEach((relativePath) => {
        if (relativePath.match(/^slide\d+\.xml$/)) {
          slideCount++
        }
      })
      
      res.json({ slideCount: slideCount || 1, format: 'pptx' })
    } else if (file.match(/\.pdf$/i)) {
      // For PDF, use pdf-lib to get page count
      const { PDFDocument } = await import('pdf-lib')
      const pdfBytes = fs.readFileSync(filePath)
      const pdfDoc = await PDFDocument.load(pdfBytes)
      res.json({ slideCount: pdfDoc.getPageCount(), format: 'pdf' })
    } else {
      res.json({ slideCount: 10, format: 'ppt' }) // Default for old .ppt format
    }
  } catch (err) {
    console.error('Error getting slide info:', err)
    res.json({ slideCount: 10, format: 'unknown' })
  }
})

// Convert PPT to PDF and then to images using LibreOffice (if available)
app.get('/api/slides/convert', async (req, res) => {
  const { file } = req.query
  if (!file) {
    return res.status(400).json({ error: 'File path required' })
  }
  
  const filePath = path.join(__dirname, 'public', file)
  const outputDir = path.join(__dirname, 'public', 'slide-images')
  const fileBaseName = path.basename(file, path.extname(file))
  const slideImagesDir = path.join(outputDir, fileBaseName)
  
  // Create output directories
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  
  // Check if images already exist
  if (fs.existsSync(slideImagesDir)) {
    const images = fs.readdirSync(slideImagesDir).filter(f => f.endsWith('.png')).sort()
    if (images.length > 0) {
      return res.json({
        success: true,
        images: images.map(img => `/slide-images/${fileBaseName}/${img}`),
        cached: true
      })
    }
  }
  
  // Create slide images directory
  fs.mkdirSync(slideImagesDir, { recursive: true })
  
  try {
    // Try to use LibreOffice for conversion
    const pdfPath = path.join(slideImagesDir, `${fileBaseName}.pdf`)
    
    // Convert PPT to PDF using LibreOffice
    try {
      await execAsync(`soffice --headless --convert-to pdf --outdir "${slideImagesDir}" "${filePath}"`)
    } catch (convertErr) {
      console.log('LibreOffice not available, using fallback')
      // Return message that conversion is not available
      return res.json({
        success: false,
        error: 'LibreOffice not installed for local conversion. Use Office Online viewer in production.',
        useOnlineViewer: true
      })
    }
    
    // Check if PDF was created
    const generatedPdf = fs.readdirSync(slideImagesDir).find(f => f.endsWith('.pdf'))
    if (!generatedPdf) {
      throw new Error('PDF conversion failed')
    }
    
    res.json({
      success: true,
      pdfPath: `/slide-images/${fileBaseName}/${generatedPdf}`,
      message: 'PDF generated successfully'
    })
  } catch (err) {
    console.error('Slide conversion error:', err)
    res.json({
      success: false,
      error: err.message,
      useOnlineViewer: true
    })
  }
})

app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' })
  }
  
  const fileUrl = `/chat-files/${req.file.filename}`
  const fileName = req.file.originalname
  const fileSize = req.file.size
  const mimeType = req.file.mimetype
  
  // Determine message type based on mime type
  let messageType = 'file'
  if (mimeType.startsWith('image/')) {
    messageType = 'image'
  } else if (mimeType.startsWith('video/')) {
    messageType = 'video'
  } else if (mimeType.startsWith('audio/')) {
    messageType = 'audio'
  }
  
  res.json({ fileUrl, fileName, fileSize, messageType })
})

// Migration: Backfill activities for existing volunteers
app.post('/api/migrate-activities', (req, res) => {
  // Get all volunteers
  db.all('SELECT id, created_at FROM volunteers', (err, volunteers) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }

    let processedCount = 0
    let activitiesAdded = 0

    volunteers.forEach(volunteer => {
      // Check if join activity already exists
      db.get(
        'SELECT id FROM activities WHERE volunteer_id = ? AND activity_type = "joined"',
        [volunteer.id],
        (checkErr, existingJoin) => {
          if (!existingJoin) {
            // Add join activity
            db.run(
              'INSERT INTO activities (volunteer_id, activity_type, description, created_at) VALUES (?, ?, ?, ?)',
              [volunteer.id, 'joined', 'Joined UYHO as a volunteer', volunteer.created_at],
              (joinErr) => {
                if (!joinErr) activitiesAdded++
              }
            )
          }

          // Get campaign joins for this volunteer
          db.all(
            'SELECT ct.id, ct.created_at, c.title, c.id as campaign_id FROM campaign_team ct JOIN campaigns c ON ct.campaign_id = c.id WHERE ct.volunteer_id = ?',
            [volunteer.id],
            (campErr, campaigns) => {
              if (campaigns && campaigns.length > 0) {
                campaigns.forEach(campaign => {
                  // Check if campaign join activity already exists
                  db.get(
                    'SELECT id FROM activities WHERE volunteer_id = ? AND activity_type = "joined_campaign" AND campaign_id = ?',
                    [volunteer.id, campaign.campaign_id],
                    (checkCampErr, existingCamp) => {
                      if (!existingCamp) {
                        // Add campaign join activity with role
                        db.run(
                          'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                          [volunteer.id, 'joined_campaign', `Joined campaign: ${campaign.title}`, campaign.campaign_id, campaign.title, campaign.role || 'Volunteer', campaign.created_at],
                          (campJoinErr) => {
                            if (!campJoinErr) activitiesAdded++
                          }
                        )
                      }
                    }
                  )
                })
              }

              processedCount++
              if (processedCount === volunteers.length) {
                res.json({ success: true, volunteersProcessed: volunteers.length, activitiesAdded })
              }
            }
          )
        }
      )
    })
  })
})

// Update volunteer profile
// --- Profile Update Endpoint with Robust Logging ---
app.put('/api/volunteers/:id', (req, res) => {
  const { id } = req.params;
  const { fullName, phone, address, wing, avatar, education, hoursGiven, points, position } = req.body;

  console.log('[Profile Update] Data:', { id, fullName, phone, address, wing, avatar, education, hoursGiven, points, position });

  // If only position is being updated (from committee page)
  if (position !== undefined && !fullName) {
    // Get old position first
    db.get('SELECT position FROM volunteers WHERE id = ?', [id], (getErr, oldData) => {
      const oldPosition = oldData?.position || 'Volunteer';
      
      db.run(
        'UPDATE volunteers SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [position, id],
        function(err) {
          if (err) {
            console.error('[Position Update] Error:', err);
            res.status(500).json({ error: err.message });
            return;
          }
          console.log('[Position Update] Success:', id, '->', position);
          
          // Add activity for position change
          if (position !== oldPosition) {
            const description = position === 'Volunteer' 
              ? `Stepped down from ${oldPosition}` 
              : `Appointed as ${position}`;
            db.run(
              'INSERT INTO activities (volunteer_id, activity_type, description, role) VALUES (?, ?, ?, ?)',
              [id, 'position_change', description, position],
              (actErr) => {
                if (actErr) console.error('Failed to create position change activity:', actErr);
              }
            );
          }
          
          res.json({ success: true, message: 'Position updated' });
        }
      );
    });
    return;
  }

  const stmt = db.prepare(`
    UPDATE volunteers 
    SET full_name = ?, 
        phone = ?, 
        address = ?, 
        wing = ?, 
        avatar = ?, 
        education = ?, 
        hours_given = COALESCE(?, hours_given), 
        points = COALESCE(?, points),
        position = COALESCE(?, position),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const hoursValue = (hoursGiven === undefined || hoursGiven === null || hoursGiven === '') ? null : parseInt(hoursGiven)
  const pointsValue = (points === undefined || points === null || points === '') ? null : parseInt(points)

  stmt.run(
    fullName || '', 
    phone || '', 
    address || '', 
    wing || '', 
    avatar || '', 
    education || '', 
    hoursValue, 
    pointsValue,
    position || null,
    id, 
    function (err) {
      if (err) {
        console.error('[Profile Update] Error:', err);
        res.status(500).json({ error: err.message });
        return;
      }
      console.log('[Profile Update] Success:', id);
      res.json({ success: true, message: 'Profile updated' });
    }
  );
  stmt.finalize();
});

// Avatar upload endpoint
app.post('/api/volunteers/:id/avatar', (req, res) => {
  const { id } = req.params;
  console.log('[Avatar Upload] Request for volunteer:', id);
  
  upload.single('avatar')(req, res, function(err) {
    if (err) {
      console.error('[Avatar Upload] Multer error:', err);
      return res.status(500).json({ error: 'File upload failed: ' + err.message });
    }
    
    if (!req.file) {
      console.error('[Avatar Upload] No file provided');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    console.log('[Avatar Upload] File received:', {
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    });
    
    const avatarPath = `/avatars/${req.file.filename}`;
    
    // Update database with avatar path
    db.run(
      'UPDATE volunteers SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [avatarPath, id],
      function(err) {
        if (err) {
          console.error('[Avatar Upload] Database error:', err);
          return res.status(500).json({ error: 'Database update failed: ' + err.message });
        }
        console.log('[Avatar Upload] Success - Avatar saved:', { id, path: avatarPath });
        res.json({ success: true, avatar: avatarPath });
      }
    );
  });
});

// ==================== CAMPAIGNS API ====================

// Get all campaigns (with optional user context)
app.get('/api/campaigns', (req, res) => {
  const { userId, status, wingId, includeTeam } = req.query

  // First, auto-update campaigns where event_date has passed
  const today = new Date().toISOString().split('T')[0]
  db.run(`
    UPDATE campaigns 
    SET status = 'Finished' 
    WHERE event_date IS NOT NULL 
    AND event_date < ? 
    AND status != 'Finished'
  `, [today])

  let query = `
    SELECT 
      c.*,
      v.full_name as host_name, 
      v.avatar as host_avatar,
      (SELECT COUNT(*) FROM campaign_team ct WHERE ct.campaign_id = c.id) AS joined_count,
      (SELECT COUNT(*) FROM campaign_team ct WHERE ct.campaign_id = c.id AND ct.approval_status = 'approved') AS team_count,
      CASE 
        WHEN c.event_date IS NOT NULL THEN 
          MAX(0, CAST(julianday(c.event_date) - julianday('now') AS INTEGER))
        ELSE c.days_left 
      END AS days_left
  `
  const params = []

  if (userId) {
    query += `,
      CASE WHEN EXISTS (
        SELECT 1 FROM campaign_team ct2 WHERE ct2.campaign_id = c.id AND ct2.volunteer_id = ?
      ) THEN 1 ELSE 0 END AS is_joined,
      (
        SELECT role FROM campaign_team ct3 WHERE ct3.campaign_id = c.id AND ct3.volunteer_id = ? LIMIT 1
      ) AS user_role
    `
    params.push(userId, userId)
  } else {
    query += ', 0 AS is_joined, NULL AS user_role'
  }

  query += '\n    FROM campaigns c'
  query += '\n    LEFT JOIN volunteers v ON c.host_id = v.id'
  
  // Add filters
  let whereClause = ''
  
  if (status) {
    if (status === 'approved') {
      whereClause += ` c.approval_status = 'approved'`
    } else if (status === 'declined') {
      whereClause += ` c.approval_status = 'declined'`
    } else if (status === 'pending') {
      whereClause += ` (c.approval_status = 'pending' OR c.approval_status IS NULL)`
    } else if (status === 'active') {
      // For donations page - only show active campaigns with future event dates
      whereClause += ` c.approval_status = 'approved' AND c.status != 'Finished' AND (c.event_date IS NULL OR c.event_date >= date('now'))`
    }
  }
  
  if (wingId) {
    if (whereClause) whereClause += ' AND '
    whereClause += ` (c.hosted_by_wing_id = ? OR c.wing = (SELECT name FROM wings WHERE id = ?))`
    params.push(wingId, wingId)
  }
  
  if (whereClause) {
    query += ` WHERE ${whereClause}`
  }
  
  query += ' ORDER BY c.created_at DESC'

  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    
    // If includeTeam is requested, fetch team members for each campaign
    if (includeTeam === 'true' && rows.length > 0) {
      const campaignIds = rows.map(c => c.id);
      const placeholders = campaignIds.map(() => '?').join(',');
      
      db.all(`
        SELECT ct.*, v.full_name, v.avatar, v.position, v.digital_id,
               ct.campaign_id
        FROM campaign_team ct
        JOIN volunteers v ON ct.volunteer_id = v.id
        WHERE ct.campaign_id IN (${placeholders}) AND ct.approval_status = 'approved'
        ORDER BY ct.role = 'Program Host' DESC, ct.created_at ASC
      `, campaignIds, (teamErr, teamMembers) => {
        if (teamErr) {
          // Return without team on error
          return res.json(rows);
        }
        
        // Group team by campaign
        const teamByCampaign = {};
        teamMembers.forEach(m => {
          if (!teamByCampaign[m.campaign_id]) teamByCampaign[m.campaign_id] = [];
          teamByCampaign[m.campaign_id].push({
            id: m.id,
            volunteer_id: m.volunteer_id,
            full_name: m.full_name,
            avatar: m.avatar,
            position: m.position,
            digital_id: m.digital_id,
            role: m.role
          });
        });
        
        // Attach team to campaigns
        rows.forEach(campaign => {
          campaign.team = teamByCampaign[campaign.id] || [];
        });
        
        res.json(rows);
      });
    } else {
      res.json(rows);
    }
  })
})

// Get all campaigns for approval (pending campaigns) - MUST be before :id route
app.get('/api/campaigns/pending', (req, res) => {
  db.all(`
    SELECT c.*, v.full_name as host_name, v.avatar as host_avatar
    FROM campaigns c
    LEFT JOIN volunteers v ON c.host_id = v.id
    WHERE c.approval_status = 'pending' OR c.approval_status IS NULL
    ORDER BY c.created_at DESC
  `, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Get single campaign with team and user context
app.get('/api/campaigns/:id', (req, res) => {
  const { id } = req.params
  const { userId } = req.query

  let query = `
    SELECT 
      c.*,
      (SELECT COUNT(*) FROM campaign_team WHERE campaign_id = c.id) AS joined_count,
      0 AS is_joined,
      NULL AS user_role
    FROM campaigns c
    WHERE c.id = ?
  `
  let params = [id]

  if (userId) {
    query = `
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM campaign_team WHERE campaign_id = c.id) AS joined_count,
        CASE WHEN EXISTS (
          SELECT 1 FROM campaign_team WHERE campaign_id = c.id AND volunteer_id = ?
        ) THEN 1 ELSE 0 END AS is_joined,
        (
          SELECT role FROM campaign_team WHERE campaign_id = c.id AND volunteer_id = ? LIMIT 1
        ) AS user_role,
        CASE 
          WHEN c.event_date IS NOT NULL THEN 
            MAX(0, CAST(julianday(c.event_date) - julianday('now') AS INTEGER))
          ELSE c.days_left 
        END AS days_left
      FROM campaigns c
      WHERE c.id = ?
    `
    params = [userId, userId, id]
  } else {
    query = `
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM campaign_team WHERE campaign_id = c.id) AS joined_count,
        0 AS is_joined,
        NULL AS user_role,
        CASE 
          WHEN c.event_date IS NOT NULL THEN 
            MAX(0, CAST(julianday(c.event_date) - julianday('now') AS INTEGER))
          ELSE c.days_left 
        END AS days_left
      FROM campaigns c
      WHERE c.id = ?
    `
    params = [id]
  }

  db.get(query, params, (err, campaign) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    db.all(
      `
        SELECT ct.*, v.full_name, v.avatar, v.wing, v.position, v.digital_id
        FROM campaign_team ct
        JOIN volunteers v ON ct.volunteer_id = v.id
        WHERE ct.campaign_id = ?
      `,
      [id],
      (teamErr, team) => {
        if (teamErr) {
          res.status(500).json({ error: teamErr.message })
          return
        }
        res.json({ ...campaign, team: team || [] })
      }
    )
  })
})

// Create campaign with team
app.post('/api/campaigns', (req, res) => {
  const {
    title,
    wing,
    description,
    budget,
    logistics,
    equipment,
    marketing,
    location,
    date,
    budgetBreakdown,
    image,
    volunteersNeeded,
    goal,
    daysLeft,
    urgency,
    hostId,
    program_hours,
    program_respect,
    lives_impacted,
    team
  } = req.body
  
  if (!title || !wing || !description) {
    return res.status(400).json({ error: 'Title, wing and description are required' })
  }

  const campaignHours = program_hours || 0
  const campaignRespect = program_respect || 0
  const campaignLivesImpacted = lives_impacted || 0

  const stmt = db.prepare(`
    INSERT INTO campaigns (title, wing, description, budget, logistics, equipment, marketing, image, location, event_date, budget_breakdown, volunteers_needed, goal, days_left, urgency, host_id, volunteers_joined, program_hours, program_respect, lives_impacted, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `)

  stmt.run(
    title,
    wing,
    description,
    budget || 0,
    logistics || 0,
    equipment || 0,
    marketing || 0,
    image || '',
    location || 'TBD',
    date || null,
    budgetBreakdown || '[]',
    volunteersNeeded || 10,
    goal || budget || 0,
    daysLeft || 30,
    urgency ? 1 : 0,
    hostId || null,
    team?.length || 0,
    campaignHours,
    campaignRespect,
    campaignLivesImpacted,
    function(err) {
      if (err) {
        console.error('[Campaign Create] Error:', err)
        res.status(500).json({ error: err.message })
        return
      }
      
      const campaignId = this.lastID
      
      // Auto-add host as Program Host
      if (hostId) {
        db.run(
          'INSERT INTO campaign_team (campaign_id, volunteer_id, role, task_note, hours, respect, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [campaignId, hostId, 'Program Host', 'Campaign creator and host', campaignHours, campaignRespect, 'approved'],
          (hostErr) => {
            if (hostErr) console.error('Failed to add host to team:', hostErr)
            else {
              // Add activity for hosting
              db.get('SELECT title FROM campaigns WHERE id = ?', [campaignId], (titleErr, campData) => {
                if (!titleErr && campData) {
                  db.run(
                    'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                    [hostId, 'joined_campaign', `Created campaign: ${campData.title}`, campaignId, campData.title, 'Program Host']
                  )
                }
              })
            }
          }
        )
      }
      
      // Add team members if provided
      if (team && team.length > 0) {
        const teamStmt = db.prepare(`
          INSERT INTO campaign_team (campaign_id, volunteer_id, role, task_note, hours, respect, approval_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        
        team.forEach(member => {
          teamStmt.run(
            campaignId, 
            member.volunteerId, 
            member.role, 
            member.taskNote || '', 
            campaignHours, 
            campaignRespect,
            'pending'
          )
        })
        teamStmt.finalize()
      }

      syncCampaignJoined(campaignId)
      console.log('[Campaign Create] Success:', campaignId)
      res.json({ success: true, id: campaignId, message: 'Campaign created successfully' })
    }
  )
  stmt.finalize()
})

// Update campaign
app.put('/api/campaigns/:id', (req, res) => {
  const { id } = req.params
  const { title, wing, description, budget, image, location, volunteersNeeded, goal, daysLeft, urgency, status, date, budgetBreakdown, programHours, programRespect } = req.body

  console.log('[Campaign Update] Received:', { id, title, image, date, budgetBreakdown })

  db.run(
    `
    UPDATE campaigns 
    SET title = COALESCE(?, title),
        wing = COALESCE(?, wing),
        description = COALESCE(?, description),
        budget = COALESCE(?, budget),
        image = COALESCE(?, image),
        location = COALESCE(?, location),
        event_date = COALESCE(?, event_date),
        budget_breakdown = COALESCE(?, budget_breakdown),
        program_hours = COALESCE(?, program_hours),
        program_respect = COALESCE(?, program_respect),
        volunteers_needed = COALESCE(?, volunteers_needed),
        goal = COALESCE(?, goal),
        days_left = COALESCE(?, days_left),
        urgency = COALESCE(?, urgency),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    [
      title,
      wing,
      description,
      budget,
      image,
      location,
      date,
      budgetBreakdown,
      programHours,
      programRespect,
      volunteersNeeded,
      goal,
      daysLeft,
      urgency ? 1 : 0,
      status,
      id
    ],
    function(err) {
      if (err) {
        console.error('[Campaign Update] Error:', err)
        res.status(500).json({ error: err.message })
        return
      }
      console.log('[Campaign Update] Success:', id)
      syncCampaignJoined(id)
      res.json({ success: true, message: 'Campaign updated' })
    }
  )
})

// Join campaign (adds volunteer to campaign_team)
app.post('/api/campaigns/:id/join', (req, res) => {
  const { id } = req.params
  const { volunteerId, role, taskNote, hours, respect } = req.body

  if (!volunteerId) {
    return res.status(400).json({ error: 'volunteerId is required' })
  }

  // First check if campaign is finished or event date has passed
  db.get('SELECT program_hours, program_respect, status, event_date FROM campaigns WHERE id = ?', [id], (campaignErr, campaign) => {
    if (campaignErr) {
      res.status(500).json({ error: campaignErr.message })
      return
    }

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    // Check if campaign is finished or event date has passed
    if (campaign.status === 'Finished') {
      return res.status(400).json({ error: 'This campaign has already finished. You cannot join anymore.' })
    }

    if (campaign.event_date) {
      const eventDate = new Date(campaign.event_date)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      if (eventDate < today) {
        return res.status(400).json({ error: 'This campaign has already taken place. You cannot join anymore.' })
      }
    }

    const defaultHours = hours ?? campaign?.program_hours ?? 0
    const defaultRespect = respect ?? campaign?.program_respect ?? 0

    db.get(
      'SELECT 1 FROM campaign_team WHERE campaign_id = ? AND volunteer_id = ? LIMIT 1',
      [id, volunteerId],
      (checkErr, row) => {
        if (checkErr) {
          res.status(500).json({ error: checkErr.message })
          return
        }

        if (row) {
          return res.json({ success: true, alreadyJoined: true })
        }

        db.run(
          'INSERT INTO campaign_team (campaign_id, volunteer_id, role, task_note, hours, respect, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, volunteerId, role || 'Volunteer', taskNote || '', defaultHours, defaultRespect, 'pending'],
          function(insertErr) {
            if (insertErr) {
              res.status(500).json({ error: insertErr.message })
              return
            }

            syncCampaignJoined(id)

            // Get campaign title and add activity
            db.get('SELECT title FROM campaigns WHERE id = ?', [id], (campErr, campData) => {
              if (!campErr && campData) {
                db.run(
                  'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                  [volunteerId, 'joined_campaign', `Joined campaign: ${campData.title}`, id, campData.title, role || 'Volunteer'],
                  (actErr) => {
                    if (actErr) console.error('Failed to create campaign join activity:', actErr)
                  }
                )
              }
            })

            db.get('SELECT COUNT(*) AS count FROM campaign_team WHERE campaign_id = ?', [id], (countErr, countRow) => {
              if (countErr) {
                res.status(500).json({ error: countErr.message })
                return
              }
              res.json({ success: true, joinedCount: countRow?.count || 0 })
            })
          }
        )
      }
    )
  })
})

// Update a campaign team member's role/task note
app.put('/api/campaigns/:id/team/:memberId', (req, res) => {
  const { id, memberId } = req.params
  const { role, taskNote } = req.body

  db.run(
    'UPDATE campaign_team SET role = COALESCE(?, role), task_note = COALESCE(?, task_note), created_at = created_at WHERE id = ? AND campaign_id = ?',
    [role, taskNote, memberId, id],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message })
        return
      }
      if (this.changes === 0) {
        res.status(404).json({ error: 'Team member not found' })
        return
      }
      res.json({ success: true })
    }
  )
})

// Approve a campaign team member (director only)
app.post('/api/campaigns/:id/team/:memberId/approve', (req, res) => {
  const { id, memberId } = req.params

  // Get team member details
  db.get(
    'SELECT ct.*, c.host_id, c.title as campaign_title FROM campaign_team ct JOIN campaigns c ON ct.campaign_id = c.id WHERE ct.id = ? AND ct.campaign_id = ?',
    [memberId, id],
    (err, member) => {
      if (err) {
        return res.status(500).json({ error: err.message })
      }
      if (!member) {
        return res.status(404).json({ error: 'Team member not found' })
      }
      if (member.approval_status === 'approved') {
        return res.json({ success: true, message: 'Already approved' })
      }

      // Update approval status
      db.run(
        'UPDATE campaign_team SET approval_status = ? WHERE id = ?',
        ['approved', memberId],
        function(updateErr) {
          if (updateErr) {
            return res.status(500).json({ error: updateErr.message })
          }

          // Notify the volunteer that they've been approved
          createNotification(member.volunteer_id, 'campaign_join_approved',
            `Your request to join campaign "${member.campaign_title}" has been approved! 🎉`, {
              data: { campaignId: parseInt(id), role: member.role, hoursAwarded: member.hours || 0, respectAwarded: member.respect || 0 },
              priority: 'high'
          }).catch(console.error);

          // Update volunteer profile with hours and respect (update both points and respect_points)
          db.run(
            'UPDATE volunteers SET hours_given = hours_given + ?, points = points + ?, respect_points = respect_points + ? WHERE id = ?',
            [member.hours || 0, member.respect || 0, member.respect || 0, member.volunteer_id],
            function(volErr) {
              if (volErr) {
                console.error('Failed to update volunteer profile:', volErr)
                return res.status(500).json({ error: 'Failed to update volunteer profile' })
              }

              // Add activity for joining campaign as team member
              db.get('SELECT title FROM campaigns WHERE id = ?', [id], (titleErr, campaign) => {
                if (!titleErr && campaign) {
                  // Check if activity already exists
                  db.get(
                    'SELECT id FROM activities WHERE volunteer_id = ? AND activity_type = "joined_campaign" AND campaign_id = ?',
                    [member.volunteer_id, id],
                    (actCheckErr, existingActivity) => {
                      if (!actCheckErr && !existingActivity) {
                        const roleDesc = member.role === 'Program Host' ? 'host' : member.role.toLowerCase();
                        db.run(
                          'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                          [member.volunteer_id, 'joined_campaign', `Joined campaign as ${roleDesc}: ${campaign.title}`, id, campaign.title, member.role],
                          (actErr) => {
                            if (actErr) console.error('Failed to create team member activity:', actErr);
                          }
                        );
                      }
                    }
                  );
                }
              });

              res.json({ success: true, message: 'Team member approved', hoursAdded: member.hours || 0, respectAdded: member.respect || 0 })
            }
          )
        }
      )
    }
  )
})

// Sync pending team members with campaign's program rewards
app.post('/api/campaigns/:id/sync-rewards', (req, res) => {
  const { id } = req.params

  db.get('SELECT program_hours, program_respect FROM campaigns WHERE id = ?', [id], (err, campaign) => {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    const hours = campaign.program_hours || 0
    const respect = campaign.program_respect || 0

    db.run(
      'UPDATE campaign_team SET hours = ?, respect = ? WHERE campaign_id = ? AND approval_status = "pending" AND (hours = 0 OR respect = 0)',
      [hours, respect, id],
      function(updateErr) {
        if (updateErr) {
          return res.status(500).json({ error: updateErr.message })
        }
        return res.json({ success: true, updated: this.changes, hours, respect })
      }
    )
  })
})

// Assign hours/respect to team members (bulk or single)
app.post('/api/campaigns/:id/assign-credits', (req, res) => {
  const { id } = req.params
  const { hours, respect, memberId } = req.body

  const h = parseInt(hours) || 0
  const r = parseInt(respect) || 0

  if (memberId) {
    db.run(
      'UPDATE campaign_team SET hours = ?, respect = ? WHERE id = ? AND campaign_id = ?',
      [h, r, memberId, id],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message })
        }
        return res.json({ success: true, updated: this.changes })
      }
    )
  } else {
    db.run(
      'UPDATE campaign_team SET hours = ?, respect = ? WHERE campaign_id = ? AND approval_status = "pending"',
      [h, r, id],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message })
        }
        return res.json({ success: true, updated: this.changes })
      }
    )
  }
})

// Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM campaign_team WHERE campaign_id = ?', [id]);
  db.run('DELETE FROM campaigns WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Campaign deleted' });
  });
});

// Approve campaign
app.post('/api/campaigns/:id/approve', (req, res) => {
  const { id } = req.params;
  const { reviewerId } = req.body;
  
  db.run(`
    UPDATE campaigns 
    SET approval_status = 'approved', 
        reviewed_by = ?, 
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reviewerId, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }

    // Get campaign details for activities
    db.get('SELECT title, host_id FROM campaigns WHERE id = ?', [id], (campErr, campaign) => {
      if (campErr || !campaign) {
        console.error('Failed to get campaign details:', campErr);
      } else {
        // Add hosting activity for campaign creator (if not already exists)
        if (campaign.host_id) {
          db.get(
            'SELECT id FROM activities WHERE volunteer_id = ? AND activity_type = "joined_campaign" AND campaign_id = ?',
            [campaign.host_id, id],
            (actCheckErr, existingActivity) => {
              if (!actCheckErr && !existingActivity) {
                db.run(
                  'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                  [campaign.host_id, 'joined_campaign', `Hosting campaign: ${campaign.title}`, id, campaign.title, 'Program Host'],
                  (actErr) => {
                    if (actErr) console.error('Failed to create host activity:', actErr);
                  }
                );
              }
            }
          );
        }

        // Add activities for all approved team members
        db.all(
          'SELECT volunteer_id, role FROM campaign_team WHERE campaign_id = ? AND approval_status = "approved"',
          [id],
          (teamErr, teamMembers) => {
            if (teamErr) {
              console.error('Failed to get team members:', teamErr);
            } else {
              teamMembers.forEach(member => {
                // Check if activity already exists
                db.get(
                  'SELECT id FROM activities WHERE volunteer_id = ? AND activity_type = "joined_campaign" AND campaign_id = ?',
                  [member.volunteer_id, id],
                  (actCheckErr, existingActivity) => {
                    if (!actCheckErr && !existingActivity) {
                      const roleDesc = member.role === 'Program Host' ? 'host' : member.role.toLowerCase();
                      db.run(
                        'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                        [member.volunteer_id, 'joined_campaign', `Joined campaign as ${roleDesc}: ${campaign.title}`, id, campaign.title, member.role],
                        (actErr) => {
                          if (actErr) console.error('Failed to create team member activity:', actErr);
                        }
                      );
                    }
                  }
                );
              });
            }
          }
        );
      }
    });
    
    // Log the approval action
    db.run(`
      INSERT INTO access_logs (action_type, action_description, actor_id, target_id, target_type, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `, ['campaign_approved', `Approved campaign`, reviewerId, id, 'campaign', JSON.stringify({ campaignId: id })]);
    
    res.json({ success: true, message: 'Campaign approved' });
  });
});

// Decline campaign
app.post('/api/campaigns/:id/decline', (req, res) => {
  const { id } = req.params;
  const { reviewerId, reason } = req.body;
  
  db.run(`
    UPDATE campaigns 
    SET approval_status = 'declined', 
        decline_reason = ?,
        reviewed_by = ?, 
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reason, reviewerId, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Campaign declined' });
  });
});

// Image generation (Gemini only per user request)
app.post('/api/openrouter/generate-image', async (req, res) => {
  const { prompt } = req.body

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' })
  }

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY
  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'Google Gemini API key not configured' })
  }

  // Build detailed image generation prompt based on campaign context
  const campaignTitle = prompt.match(/Campaign:\s*([^\n]+)/i)?.[1] || 'Community'
  const campaignWing = prompt.match(/Wing:\s*([^\n]+)/i)?.[1] || 'Community'
  const campaignLocation = prompt.match(/Location:\s*([^\n]+)/i)?.[1] || 'Outdoor Campus'

  const detailedPrompt = `A clean, soft cartoon-style illustration of "${campaignTitle}" campaign organized by UYHO youth organization.
Setting: ${campaignLocation}, educational outdoor environment with trees, sunlight, peaceful atmosphere.
Content: Young students and diverse teenagers (10-25 years old) working in groups, engaged in activities related to ${campaignWing}.
Mentor figures guiding and supporting participants.
Diverse people, friendly approachable faces, modest casual clothing, warm and welcoming expressions.
Visual elements: Collaborative activities, learning materials, innovation themes, teamwork visualization.
Color Palette: Warm pastel colors, soft painterly shading, smooth gradients.
Style: Semi-realistic cartoon illustration, similar to modern educational artwork and children's book illustrations.
Composition: Cinematic composition, depth of field, dynamic group arrangement, atmospheric lighting.
Quality: High quality, detailed, professional illustration.
Aspect Ratio: 16:9 widescreen.
IMPORTANT - Do NOT include: photorealistic faces, anime style, 3D renders, sharp outlines, harsh shadows, dark mood, text, watermarks, logos.
Mood: Hopeful, inspiring, educational, representing innovation, teamwork, and future thinkers.`

  console.log('Calling Gemini direct for image generation, wing:', campaignWing, 'title:', campaignTitle)

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${GOOGLE_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: detailedPrompt }] }]
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.warn('Gemini request failed:', response.status, errorText)
      return res.status(502).json({ error: 'Gemini request failed', status: response.status, details: errorText })
    }

    const data = await response.json()
    console.log('Gemini response:', JSON.stringify(data).substring(0, 300))

    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!content) {
      return res.status(502).json({ error: 'Gemini did not return content' })
    }

    const urlMatch = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp)/i)
    if (urlMatch) {
      console.log('Gemini returned image URL:', urlMatch[0])
      return res.json({ success: true, imageUrl: urlMatch[0], model: 'gemini-2.0-flash-exp-image-generation' })
    }

    return res.status(502).json({ error: 'Gemini did not return an image URL', details: content.substring(0, 200) })
  } catch (err) {
    console.warn('Gemini request error:', err.message)
    return res.status(500).json({ error: 'Gemini request error', details: err.message })
  }
})

// ==================== WINGS API ====================

// Wing roles constant
const WING_ROLES = [
  { role: 'Wing Chief Executive', sort_order: 1 },
  { role: 'Wing Deputy Executive', sort_order: 2 },
  { role: 'Wing Secretary', sort_order: 3 },
  { role: 'Wing Treasurer', sort_order: 4 },
  { role: 'Wing Coordinator', sort_order: 5 },
  { role: 'Wing Senior Member', sort_order: 6 },
  { role: 'Wing Member', sort_order: 7 }
];

// Get wing roles list
app.get('/api/wings/roles', (req, res) => {
  res.json(WING_ROLES);
});

// Get all wings (with filter support)
app.get('/api/wings', (req, res) => {
  const { status, includeMembers } = req.query;
  
  let query = `
    SELECT w.*, 
           v.full_name as created_by_name,
           (SELECT COUNT(*) FROM wing_members wm WHERE wm.wing_id = w.id) as member_count
    FROM wings w
    LEFT JOIN volunteers v ON w.created_by = v.id
  `;
  
  if (status === 'pending') {
    query += ` WHERE w.approval_status = 'pending' OR w.approval_status IS NULL`;
  } else if (status === 'approved') {
    query += ` WHERE w.approval_status = 'approved'`;
  } else if (status === 'declined') {
    query += ` WHERE w.approval_status = 'declined'`;
  }
  
  query += ` ORDER BY w.created_at DESC`;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // If includeMembers is requested, fetch members for each wing
    if (includeMembers === 'true' && rows.length > 0) {
      const wingIds = rows.map(w => w.id);
      const placeholders = wingIds.map(() => '?').join(',');
      
      db.all(`
        SELECT wm.*, v.id, v.full_name, v.avatar, v.position, v.digital_id,
               wm.wing_id
        FROM wing_members wm
        JOIN volunteers v ON wm.volunteer_id = v.id
        WHERE wm.wing_id IN (${placeholders})
        ORDER BY wm.sort_order ASC, wm.joined_at ASC
      `, wingIds, (memberErr, members) => {
        if (memberErr) {
          // Return without members on error
          return res.json(rows);
        }
        
        // Group members by wing
        const membersByWing = {};
        members.forEach(m => {
          if (!membersByWing[m.wing_id]) membersByWing[m.wing_id] = [];
          membersByWing[m.wing_id].push({
            id: m.id,
            volunteer_id: m.volunteer_id,
            full_name: m.full_name,
            avatar: m.avatar,
            position: m.position,
            digital_id: m.digital_id,
            wing_role: m.role,
            sort_order: m.sort_order
          });
        });
        
        // Attach members to wings
        rows.forEach(wing => {
          wing.members = membersByWing[wing.id] || [];
        });
        
        res.json(rows);
      });
    } else {
      res.json(rows);
    }
  });
});

// Get pending wings for approval
app.get('/api/wings/pending', (req, res) => {
  db.all(`
    SELECT w.*, v.full_name as created_by_name,
           (SELECT COUNT(*) FROM wing_members wm WHERE wm.wing_id = w.id) as member_count
    FROM wings w
    LEFT JOIN volunteers v ON w.created_by = v.id
    WHERE w.approval_status = 'pending' OR w.approval_status IS NULL
    ORDER BY w.created_at DESC
  `, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Get single wing with members
app.get('/api/wings/:id', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT w.*, v.full_name as created_by_name
    FROM wings w
    LEFT JOIN volunteers v ON w.created_by = v.id
    WHERE w.id = ?
  `, [id], (err, wing) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (!wing) {
      res.status(404).json({ error: 'Wing not found' });
      return;
    }
    
    // Get wing members
    db.all(`
      SELECT wm.*, v.full_name, v.avatar, v.email, v.position as central_position, v.digital_id, v.hours_given
      FROM wing_members wm
      JOIN volunteers v ON wm.volunteer_id = v.id
      WHERE wm.wing_id = ?
      ORDER BY wm.sort_order ASC, wm.joined_at ASC
    `, [id], (err, members) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      wing.members = members || [];
      res.json(wing);
    });
  });
});

// Wing donations
app.post('/api/wing-donations', (req, res) => {
  const { wingId, volunteerId, amount, donorName, phoneNumber, transactionId, paymentMethod, isAnonymous } = req.body;
  
  if (!wingId || !amount || !transactionId) {
    return res.status(400).json({ error: 'Wing ID, amount, and transaction ID are required' });
  }
  
  db.run(`
    INSERT INTO wing_donations (wing_id, volunteer_id, amount, donor_name, phone_number, transaction_id, payment_method, is_anonymous, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [wingId, volunteerId || null, amount, donorName || 'Anonymous', phoneNumber || null, transactionId, paymentMethod || 'bKash', isAnonymous ? 1 : 0], function(err) {
    if (err) {
      console.error('Error creating wing donation:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, id: this.lastID, message: 'Donation submitted for review' });
  });
});

// Get wing donations
app.get('/api/wing-donations/:wingId', (req, res) => {
  const { wingId } = req.params;
  const { status } = req.query;
  
  let query = `
    SELECT wd.*, v.full_name as volunteer_name, v.avatar as volunteer_avatar
    FROM wing_donations wd
    LEFT JOIN volunteers v ON wd.volunteer_id = v.id
    WHERE wd.wing_id = ?
  `;
  const params = [wingId];
  
  if (status) {
    query += ' AND wd.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY wd.created_at DESC';
  
  db.all(query, params, (err, donations) => {
    if (err) {
      console.error('Error fetching wing donations:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json(donations);
  });
});

// Approve/reject wing donation
app.put('/api/wing-donations/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, reviewerId } = req.body;
  
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or rejected' });
  }
  
  db.run(`
    UPDATE wing_donations 
    SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [status, reviewerId, id], function(err) {
    if (err) {
      console.error('Error updating wing donation status:', err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, message: `Donation ${status}` });
  });
});

// Get wing activities
app.get('/api/wings/:id/activities', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT a.*, v.full_name, v.avatar, v.digital_id,
           CASE 
             WHEN a.activity_type = 'joined_campaign' THEN c.title
             ELSE NULL
           END as campaign_title
    FROM activities a
    JOIN volunteers v ON a.volunteer_id = v.id
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    WHERE v.id IN (
      SELECT volunteer_id FROM wing_members WHERE wing_id = ?
    )
    OR a.campaign_id IN (
      SELECT c2.id FROM campaigns c2 WHERE c2.hosted_by_wing_id = ?
    )
    ORDER BY a.created_at DESC
    LIMIT 50
  `, [id, id], (err, activities) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(activities);
  });
});

// Create new wing
app.post('/api/wings', (req, res) => {
  const { name, description, image, location, createdBy, members } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Wing name is required' });
  }
  
  db.run(`
    INSERT INTO wings (name, description, image, location, created_by, approval_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `, [name, description || '', image || '', location || '', createdBy], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    const wingId = this.lastID;
    
    // Add members if provided
    if (members && members.length > 0) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO wing_members (wing_id, volunteer_id, role, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      
      members.forEach(member => {
        const roleInfo = WING_ROLES.find(r => r.role === member.role) || WING_ROLES[6];
        stmt.run(wingId, member.volunteerId, member.role, roleInfo.sort_order);
      });
      
      stmt.finalize();
    }
    
    res.json({ success: true, id: wingId, message: 'Wing created and pending approval' });
  });
});

// Update wing
app.put('/api/wings/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, image, location } = req.body;
  
  db.run(`
    UPDATE wings 
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        image = COALESCE(?, image),
        location = COALESCE(?, location),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [name, description, image, location, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Wing updated' });
  });
});

// Approve wing
app.post('/api/wings/:id/approve', (req, res) => {
  const { id } = req.params;
  const { reviewerId } = req.body;
  
  // First get wing name for activity description
  db.get('SELECT name FROM wings WHERE id = ?', [id], (err, wing) => {
    if (err || !wing) {
      res.status(500).json({ error: err?.message || 'Wing not found' });
      return;
    }
    
    db.run(`
      UPDATE wings 
      SET approval_status = 'approved',
          reviewed_by = ?,
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [reviewerId, id], function(updateErr) {
      if (updateErr) {
        res.status(500).json({ error: updateErr.message });
        return;
      }
      
      // Add activity for all wing members
      db.all('SELECT volunteer_id, role FROM wing_members WHERE wing_id = ?', [id], (membersErr, members) => {
        if (!membersErr && members && members.length > 0) {
          members.forEach(member => {
            db.run(
              'INSERT INTO activities (volunteer_id, activity_type, description, role) VALUES (?, ?, ?, ?)',
              [member.volunteer_id, 'joined_wing', `Joined ${wing.name} as ${member.role}`, member.role],
              (actErr) => {
                if (actErr) console.error('Failed to create wing join activity:', actErr);
              }
            );
          });
        }
      });
      
      // Log the approval action
      db.run(`
        INSERT INTO access_logs (action_type, action_description, actor_id, target_id, target_type, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ['wing_approved', `Approved wing: ${wing.name}`, reviewerId, id, 'wing', JSON.stringify({ wingId: id, wingName: wing.name })]);
      
      res.json({ success: true, message: 'Wing approved' });
    });
  });
});

// Decline wing
app.post('/api/wings/:id/decline', (req, res) => {
  const { id } = req.params;
  const { reviewerId, reason } = req.body;
  
  db.run(`
    UPDATE wings 
    SET approval_status = 'declined',
        decline_reason = ?,
        reviewed_by = ?,
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reason, reviewerId, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Wing declined' });
  });
});

// Delete wing
app.delete('/api/wings/:id', (req, res) => {
  const { id } = req.params;
  
  db.run('DELETE FROM wing_members WHERE wing_id = ?', [id]);
  db.run('DELETE FROM wings WHERE id = ?', [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Wing deleted' });
  });
});

// Add member to wing
app.post('/api/wings/:id/members', (req, res) => {
  const { id } = req.params;
  const { volunteerId, role } = req.body;
  
  const roleInfo = WING_ROLES.find(r => r.role === role) || WING_ROLES[6];
  
  // Check if wing is approved
  db.get('SELECT name, approval_status FROM wings WHERE id = ?', [id], (err, wing) => {
    if (err || !wing) {
      res.status(500).json({ error: err?.message || 'Wing not found' });
      return;
    }
    
    db.run(`
      INSERT OR REPLACE INTO wing_members (wing_id, volunteer_id, role, sort_order)
      VALUES (?, ?, ?, ?)
    `, [id, volunteerId, role, roleInfo.sort_order], function(insertErr) {
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
      
      // Add activity only if wing is approved
      if (wing.approval_status === 'approved') {
        db.run(
          'INSERT INTO activities (volunteer_id, activity_type, description, role) VALUES (?, ?, ?, ?)',
          [volunteerId, 'joined_wing', `Joined ${wing.name} as ${role}`, role],
          (actErr) => {
            if (actErr) console.error('Failed to create wing join activity:', actErr);
          }
        );
      }
      
      res.json({ success: true, message: 'Member added to wing' });
    });
  });
});

// Update member role in wing
app.put('/api/wings/:id/members/:memberId', (req, res) => {
  const { id, memberId } = req.params;
  const { role } = req.body;
  
  const roleInfo = WING_ROLES.find(r => r.role === role) || WING_ROLES[6];
  
  db.run(`
    UPDATE wing_members 
    SET role = ?, sort_order = ?
    WHERE wing_id = ? AND volunteer_id = ?
  `, [role, roleInfo.sort_order, id, memberId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Member role updated' });
  });
});

// Remove member from wing
app.delete('/api/wings/:id/members/:memberId', (req, res) => {
  const { id, memberId } = req.params;
  
  db.run(`
    DELETE FROM wing_members WHERE wing_id = ? AND volunteer_id = ?
  `, [id, memberId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true, message: 'Member removed from wing' });
  });
});

// Get volunteer's wing membership info (for profile display)
app.get('/api/volunteers/:id/wings', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT wm.role, wm.sort_order, wm.is_parent, w.id as wing_id, w.name as wing_name, w.location, w.approval_status
    FROM wing_members wm
    JOIN wings w ON wm.wing_id = w.id
    WHERE wm.volunteer_id = ? AND w.approval_status = 'approved'
    ORDER BY wm.is_parent DESC, wm.joined_at ASC
  `, [id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Set parent wing for a volunteer
app.put('/api/volunteers/:id/parent-wing', (req, res) => {
  const { id } = req.params;
  const { wingId } = req.body;
  
  // First, unset all parent wings for this volunteer
  db.run('UPDATE wing_members SET is_parent = 0 WHERE volunteer_id = ?', [id], (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Then set the new parent wing
    db.run('UPDATE wing_members SET is_parent = 1 WHERE volunteer_id = ? AND wing_id = ?', [id, wingId], function(err2) {
      if (err2) {
        res.status(500).json({ error: err2.message });
        return;
      }
      res.json({ success: true, message: 'Parent wing updated' });
    });
  });
});

// ==================== WING POSTS API ====================

// Get posts for a wing
app.get('/api/wings/:id/posts', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT wp.*, v.full_name as author_name, v.avatar as author_avatar, v.position as author_position,
           c.title as campaign_title, c.description as campaign_description, c.days_left as campaign_days_left,
           c.image as campaign_image, c.volunteers_needed, c.volunteers_joined,
           (SELECT COUNT(*) FROM wing_post_reactions WHERE post_id = wp.id) as reaction_count,
           (SELECT COUNT(*) FROM wing_post_comments WHERE post_id = wp.id) as comment_count
    FROM wing_posts wp
    JOIN volunteers v ON wp.author_id = v.id
    LEFT JOIN campaigns c ON wp.campaign_id = c.id
    WHERE wp.wing_id = ?
    ORDER BY wp.created_at DESC
  `, [id], (err, posts) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Get images, tags, and reactions for each post
    const postIds = posts.map(p => p.id);
    if (postIds.length === 0) {
      return res.json([]);
    }
    
    const placeholders = postIds.map(() => '?').join(',');
    
    // Get images
    db.all(`SELECT * FROM wing_post_images WHERE post_id IN (${placeholders}) ORDER BY sort_order`, postIds, (imgErr, images) => {
      if (imgErr) {
        return res.status(500).json({ error: imgErr.message });
      }
      
      // Get tags with volunteer info
      db.all(`
        SELECT wpt.*, v.full_name, v.avatar
        FROM wing_post_tags wpt
        JOIN volunteers v ON wpt.volunteer_id = v.id
        WHERE wpt.post_id IN (${placeholders})
      `, postIds, (tagErr, tags) => {
        if (tagErr) {
          return res.status(500).json({ error: tagErr.message });
        }
        
        // Get reactions breakdown
        db.all(`
          SELECT post_id, reaction_type, COUNT(*) as count
          FROM wing_post_reactions
          WHERE post_id IN (${placeholders})
          GROUP BY post_id, reaction_type
        `, postIds, (reactErr, reactions) => {
          if (reactErr) {
            return res.status(500).json({ error: reactErr.message });
          }
          
          // Combine all data
          const postsWithData = posts.map(post => ({
            ...post,
            images: images.filter(img => img.post_id === post.id),
            tags: tags.filter(tag => tag.post_id === post.id),
            reactions: reactions.filter(r => r.post_id === post.id)
          }));
          
          res.json(postsWithData);
        });
      });
    });
  });
});

// Create a wing post
app.post('/api/wings/:id/posts', (req, res) => {
  const { id } = req.params;
  const { authorId, content, location, images, taggedMembers, campaignId } = req.body;
  
  db.run(`
    INSERT INTO wing_posts (wing_id, author_id, content, location, campaign_id)
    VALUES (?, ?, ?, ?, ?)
  `, [id, authorId, content, location, campaignId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    const postId = this.lastID;
    
    // Add images
    if (images && images.length > 0) {
      const imgStmt = db.prepare('INSERT INTO wing_post_images (post_id, image_url, sort_order) VALUES (?, ?, ?)');
      images.forEach((img, index) => {
        imgStmt.run(postId, img, index);
      });
      imgStmt.finalize();
    }
    
    // Add tagged members
    if (taggedMembers && taggedMembers.length > 0) {
      const tagStmt = db.prepare('INSERT INTO wing_post_tags (post_id, volunteer_id) VALUES (?, ?)');
      taggedMembers.forEach(memberId => {
        tagStmt.run(postId, memberId);
      });
      tagStmt.finalize();
      
      // Notify tagged members
      db.get(`SELECT v.full_name, v.avatar, w.name as wing_name FROM volunteers v JOIN wings w ON w.id = ? WHERE v.id = ?`, 
        [id, authorId], (tagErr, authorData) => {
        if (!tagErr && authorData) {
          taggedMembers.forEach(memberId => {
            if (memberId != authorId) {
              createNotification(memberId, 'tagged_in_post',
                `tagged you in a post in ${authorData.wing_name}`, {
                  data: { postId, wingId: parseInt(id), preview: content.length > 50 ? content.slice(0, 50) + '...' : content },
                  actorId: parseInt(authorId),
                  actorName: authorData.full_name,
                  actorAvatar: authorData.avatar,
                  priority: 'high'
              }).catch(console.error);
            }
          });
        }
      });
    }
    
    res.json({ success: true, postId });
  });
});

// React to a post
app.post('/api/posts/:postId/react', (req, res) => {
  const { postId } = req.params;
  const { volunteerId, reactionType } = req.body;
  
  // Insert or update reaction
  db.run(`
    INSERT INTO wing_post_reactions (post_id, volunteer_id, reaction_type)
    VALUES (?, ?, ?)
    ON CONFLICT(post_id, volunteer_id) DO UPDATE SET reaction_type = ?
  `, [postId, volunteerId, reactionType, reactionType], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Notify post author about reaction
    db.get(`
      SELECT wp.author_id, wp.wing_id, v.full_name, v.avatar
      FROM wing_posts wp
      JOIN volunteers v ON v.id = ?
      WHERE wp.id = ?
    `, [volunteerId, postId], (postErr, postData) => {
      if (!postErr && postData && postData.author_id != volunteerId) {
        const reactionEmoji = { love: '❤️', like: '👍', celebrate: '🎉', support: '🤲', insightful: '💡' }[reactionType] || '👍';
        createNotification(postData.author_id, 'wing_post_reaction',
          `reacted ${reactionEmoji} to your post`, {
            data: { postId: parseInt(postId), wingId: postData.wing_id, reactionType },
            actorId: parseInt(volunteerId),
            actorName: postData.full_name,
            actorAvatar: postData.avatar,
            priority: 'low'
        }).catch(console.error);
      }
    });
    
    res.json({ success: true });
  });
});

// Remove reaction from post
app.delete('/api/posts/:postId/react/:volunteerId', (req, res) => {
  const { postId, volunteerId } = req.params;
  
  db.run('DELETE FROM wing_post_reactions WHERE post_id = ? AND volunteer_id = ?', [postId, volunteerId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// Get user's reaction on a post
app.get('/api/posts/:postId/react/:volunteerId', (req, res) => {
  const { postId, volunteerId } = req.params;
  
  db.get('SELECT reaction_type FROM wing_post_reactions WHERE post_id = ? AND volunteer_id = ?', [postId, volunteerId], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ reaction: row?.reaction_type || null });
  });
});

// Get comments for a post
app.get('/api/posts/:postId/comments', (req, res) => {
  const { postId } = req.params;
  
  db.all(`
    SELECT c.*, v.full_name, v.avatar,
           (SELECT COUNT(*) FROM wing_comment_reactions WHERE comment_id = c.id) as reaction_count
    FROM wing_post_comments c
    JOIN volunteers v ON c.volunteer_id = v.id
    WHERE c.post_id = ? AND c.parent_id IS NULL
    ORDER BY c.created_at ASC
  `, [postId], (err, comments) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Get replies for each comment
    const commentIds = comments.map(c => c.id);
    if (commentIds.length === 0) {
      return res.json([]);
    }
    
    const placeholders = commentIds.map(() => '?').join(',');
    db.all(`
      SELECT c.*, v.full_name, v.avatar,
             (SELECT COUNT(*) FROM wing_comment_reactions WHERE comment_id = c.id) as reaction_count
      FROM wing_post_comments c
      JOIN volunteers v ON c.volunteer_id = v.id
      WHERE c.parent_id IN (${placeholders})
      ORDER BY c.created_at ASC
    `, commentIds, (repliesErr, replies) => {
      if (repliesErr) {
        return res.status(500).json({ error: repliesErr.message });
      }
      
      const commentsWithReplies = comments.map(comment => ({
        ...comment,
        replies: replies.filter(r => r.parent_id === comment.id)
      }));
      
      res.json(commentsWithReplies);
    });
  });
});

// Add comment to a post
app.post('/api/posts/:postId/comments', (req, res) => {
  const { postId } = req.params;
  const { volunteerId, content, parentId } = req.body;
  
  db.run(`
    INSERT INTO wing_post_comments (post_id, volunteer_id, content, parent_id)
    VALUES (?, ?, ?, ?)
  `, [postId, volunteerId, content, parentId || null], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    const commentId = this.lastID;
    
    // Get commenter info and post details
    db.get(`
      SELECT wp.author_id, wp.wing_id, v.full_name, v.avatar
      FROM wing_posts wp
      JOIN volunteers v ON v.id = ?
      WHERE wp.id = ?
    `, [volunteerId, postId], (postErr, postData) => {
      if (!postErr && postData) {
        const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;
        
        // Notify post author about comment (if not the commenter)
        if (postData.author_id != volunteerId) {
          createNotification(postData.author_id, 'wing_post_comment',
            `commented on your post`, {
              data: { postId: parseInt(postId), wingId: postData.wing_id, preview },
              actorId: parseInt(volunteerId),
              actorName: postData.full_name,
              actorAvatar: postData.avatar,
              priority: 'normal'
          }).catch(console.error);
        }
        
        // If this is a reply, notify the parent comment author
        if (parentId) {
          db.get('SELECT volunteer_id FROM wing_post_comments WHERE id = ?', [parentId], (parentErr, parentComment) => {
            if (!parentErr && parentComment && parentComment.volunteer_id != volunteerId && parentComment.volunteer_id != postData.author_id) {
              createNotification(parentComment.volunteer_id, 'comment_reply',
                `replied to your comment`, {
                  data: { postId: parseInt(postId), wingId: postData.wing_id, commentId, preview },
                  actorId: parseInt(volunteerId),
                  actorName: postData.full_name,
                  actorAvatar: postData.avatar,
                  priority: 'normal'
              }).catch(console.error);
            }
          });
        }
      }
    });
    
    res.json({ success: true, commentId });
  });
});

// React to a comment
app.post('/api/comments/:commentId/react', (req, res) => {
  const { commentId } = req.params;
  const { volunteerId, reactionType } = req.body;
  
  db.run(`
    INSERT INTO wing_comment_reactions (comment_id, volunteer_id, reaction_type)
    VALUES (?, ?, ?)
    ON CONFLICT(comment_id, volunteer_id) DO UPDATE SET reaction_type = ?
  `, [commentId, volunteerId, reactionType, reactionType], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// Create wing campaign request (hosted by wing)
app.post('/api/wings/:id/campaign-request', (req, res) => {
  const { id } = req.params;
  const { title, description, wing, deadline, location, image, volunteersNeeded, budget, budgetBreakdown, programHours, programRespect, livesImpacted, team, createdBy } = req.body;
  
  const campaignHours = programHours || 0;
  const campaignRespect = programRespect || 0;
  const campaignBudget = budget || 0;
  const campaignLivesImpacted = livesImpacted || 0;
  
  // Get wing info
  db.get('SELECT name FROM wings WHERE id = ?', [id], (err, wingData) => {
    if (err || !wingData) {
      res.status(500).json({ error: err?.message || 'Wing not found' });
      return;
    }
    
    db.run(`
      INSERT INTO campaigns (title, description, wing, event_date, location, image, volunteers_needed, budget, budget_breakdown, host_id, status, approval_status, hosted_by_wing_id, hosted_by_name, program_hours, program_respect, lives_impacted, volunteers_joined, goal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'pending', ?, ?, ?, ?, ?, ?, ?)
    `, [title, description, wing, deadline, location, image, volunteersNeeded, campaignBudget, budgetBreakdown, createdBy, id, wingData.name, campaignHours, campaignRespect, campaignLivesImpacted, team?.length || 0, campaignBudget], function(insertErr) {
      if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
      }
      
      const campaignId = this.lastID;
      
      // Auto-add creator as Program Host
      if (createdBy) {
        db.run(
          'INSERT INTO campaign_team (campaign_id, volunteer_id, role, task_note, hours, respect, approval_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [campaignId, createdBy, 'Program Host', 'Campaign creator and host', campaignHours, campaignRespect, 'approved'],
          (hostErr) => {
            if (hostErr) {
              console.error('Failed to add host to team:', hostErr);
            } else {
              // Add hosting activity for creator
              db.run(
                'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
                [createdBy, 'joined_campaign', `Hosting wing campaign: ${title}`, campaignId, title, 'Program Host'],
                (actErr) => {
                  if (actErr) console.error('Failed to create host activity:', actErr);
                }
              );
            }
          }
        );
      }
      
      // Add team members if provided
      if (team && team.length > 0) {
        const teamStmt = db.prepare(`
          INSERT INTO campaign_team (campaign_id, volunteer_id, role, task_note, hours, respect, approval_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        team.forEach(member => {
          teamStmt.run(
            campaignId,
            member.volunteerId,
            member.role,
            member.taskNote || '',
            member.hours || campaignHours,
            member.respect || campaignRespect,
            'approved' // Auto-approve wing team assignments
          );
          
          // Add activity for each team member
          const roleDesc = member.role === 'Program Host' ? 'host' : member.role.toLowerCase();
          db.run(
            'INSERT INTO activities (volunteer_id, activity_type, description, campaign_id, campaign_title, role) VALUES (?, ?, ?, ?, ?, ?)',
            [member.volunteerId, 'joined_campaign', `Joined wing campaign as ${roleDesc}: ${title}`, campaignId, title, member.role],
            (actErr) => {
              if (actErr) console.error('Failed to create team member activity:', actErr);
            }
          );
        });
        teamStmt.finalize();
      }
      
      syncCampaignJoined(campaignId);
      res.json({ success: true, campaignId });
    });
  });
});

// Auto-post when campaign is approved (add this to campaign approval logic)
// This function can be called when a campaign hosted by a wing is approved
const createCampaignPost = (campaignId, wingId) => {
  db.get('SELECT * FROM campaigns WHERE id = ?', [campaignId], (err, campaign) => {
    if (err || !campaign) return;
    
    db.run(`
      INSERT INTO wing_posts (wing_id, author_id, content, campaign_id)
      VALUES (?, ?, ?, ?)
    `, [wingId, campaign.created_by, `🎯 New Campaign: ${campaign.title}\n\n${campaign.description}`, campaignId], (postErr) => {
      if (postErr) console.error('Failed to create campaign post:', postErr);
    });
  });
};

// ==================== END WING POSTS API ====================

// ==================== WING SETTINGS/ADMIN API ====================

// Get wing settings (for edit page)
app.get('/api/wings/:id/settings', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT w.*, 
           (SELECT COUNT(*) FROM wing_join_requests WHERE wing_id = w.id AND status = 'pending') as pending_requests
    FROM wings w WHERE w.id = ?
  `, [id], (err, wing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!wing) return res.status(404).json({ error: 'Wing not found' });
    
    // Get admins
    db.all(`
      SELECT wm.*, v.full_name, v.avatar, v.position
      FROM wing_members wm
      JOIN volunteers v ON wm.volunteer_id = v.id
      WHERE wm.wing_id = ? AND (wm.is_admin = 1 OR wm.sort_order = 1)
      ORDER BY wm.sort_order
    `, [id], (err2, admins) => {
      if (err2) return res.status(500).json({ error: err2.message });
      
      res.json({ ...wing, admins });
    });
  });
});

// Update wing settings
app.put('/api/wings/:id/settings', (req, res) => {
  const { id } = req.params;
  const { name, bio, description, image, cover_image, join_approval_required } = req.body;
  
  db.run(`
    UPDATE wings 
    SET name = COALESCE(?, name),
        bio = COALESCE(?, bio),
        description = COALESCE(?, description),
        image = COALESCE(?, image),
        cover_image = COALESCE(?, cover_image),
        join_approval_required = COALESCE(?, join_approval_required),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [name, bio, description, image, cover_image, join_approval_required, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get wing admins
app.get('/api/wings/:id/admins', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT wm.*, v.full_name, v.avatar, v.position
    FROM wing_members wm
    JOIN volunteers v ON wm.volunteer_id = v.id
    WHERE wm.wing_id = ? AND (wm.is_admin = 1 OR wm.sort_order = 1)
    ORDER BY wm.sort_order
  `, [id], (err, admins) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(admins);
  });
});

// Add admin
app.post('/api/wings/:id/admins', (req, res) => {
  const { id } = req.params;
  const { volunteerId } = req.body;
  
  db.run(`UPDATE wing_members SET is_admin = 1 WHERE wing_id = ? AND volunteer_id = ?`, 
    [id, volunteerId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Remove admin
app.delete('/api/wings/:id/admins/:volunteerId', (req, res) => {
  const { id, volunteerId } = req.params;
  
  // Can't remove the top position (sort_order = 1) from admin
  db.get('SELECT sort_order FROM wing_members WHERE wing_id = ? AND volunteer_id = ?', 
    [id, volunteerId], (err, member) => {
      if (err) return res.status(500).json({ error: err.message });
      if (member?.sort_order === 1) {
        return res.status(400).json({ error: 'Cannot remove top position from admin' });
      }
      
      db.run(`UPDATE wing_members SET is_admin = 0 WHERE wing_id = ? AND volunteer_id = ?`, 
        [id, volunteerId], function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true });
        }
      );
    }
  );
});

// Transfer top admin position
app.put('/api/wings/:id/transfer-admin', (req, res) => {
  const { id } = req.params;
  const { fromVolunteerId, toVolunteerId } = req.body;
  
  // Get current roles
  db.get('SELECT role, sort_order FROM wing_members WHERE wing_id = ? AND volunteer_id = ?', 
    [id, fromVolunteerId], (err, fromMember) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!fromMember || fromMember.sort_order !== 1) {
        return res.status(400).json({ error: 'Only top position can transfer' });
      }
      
      db.get('SELECT role, sort_order FROM wing_members WHERE wing_id = ? AND volunteer_id = ?', 
        [id, toVolunteerId], (err2, toMember) => {
          if (err2) return res.status(500).json({ error: err2.message });
          if (!toMember || toMember.sort_order > 6) {
            return res.status(400).json({ error: 'Can only transfer to committee members' });
          }
          
          // Swap roles
          db.run(`UPDATE wing_members SET role = ?, sort_order = ? WHERE wing_id = ? AND volunteer_id = ?`,
            [toMember.role, toMember.sort_order, id, fromVolunteerId], (err3) => {
              if (err3) return res.status(500).json({ error: err3.message });
              
              db.run(`UPDATE wing_members SET role = ?, sort_order = 1, is_admin = 1 WHERE wing_id = ? AND volunteer_id = ?`,
                [fromMember.role, id, toVolunteerId], (err4) => {
                  if (err4) return res.status(500).json({ error: err4.message });
                  res.json({ success: true });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Manage committee members - promote
app.put('/api/wings/:id/members/:volunteerId/promote', (req, res) => {
  const { id, volunteerId } = req.params;
  const { newRole, newSortOrder } = req.body;
  
  db.run(`UPDATE wing_members SET role = ?, sort_order = ? WHERE wing_id = ? AND volunteer_id = ?`,
    [newRole, newSortOrder, id, volunteerId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Manage committee members - remove from position (demote to regular member)
app.put('/api/wings/:id/members/:volunteerId/demote', (req, res) => {
  const { id, volunteerId } = req.params;
  
  db.run(`UPDATE wing_members SET role = 'Wing Member', sort_order = 7, is_admin = 0 WHERE wing_id = ? AND volunteer_id = ?`,
    [id, volunteerId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Get join requests
app.get('/api/wings/:id/join-requests', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT jr.*, v.full_name, v.avatar, v.position, v.hours_given
    FROM wing_join_requests jr
    JOIN volunteers v ON jr.volunteer_id = v.id
    WHERE jr.wing_id = ? AND jr.status = 'pending'
    ORDER BY jr.requested_at DESC
  `, [id], (err, requests) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(requests);
  });
});

// Submit join request
app.post('/api/wings/:id/join-request', (req, res) => {
  const { id } = req.params;
  const { volunteerId } = req.body;
  
  // Check if wing requires approval
  db.get('SELECT join_approval_required FROM wings WHERE id = ?', [id], (err, wing) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (wing?.join_approval_required) {
      // Add to join requests
      db.run(`INSERT OR REPLACE INTO wing_join_requests (wing_id, volunteer_id, status) VALUES (?, ?, 'pending')`,
        [id, volunteerId], function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true, pending: true });
        }
      );
    } else {
      // Direct join
      db.run(`INSERT OR REPLACE INTO wing_members (wing_id, volunteer_id, role, sort_order) VALUES (?, ?, 'Wing Member', 7)`,
        [id, volunteerId], function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true, pending: false });
        }
      );
    }
  });
});

// Approve join request
app.put('/api/wings/:id/join-requests/:requestId/approve', (req, res) => {
  const { id, requestId } = req.params;
  const { reviewerId } = req.body;
  
  db.get('SELECT jr.volunteer_id, w.name as wing_name FROM wing_join_requests jr JOIN wings w ON jr.wing_id = w.id WHERE jr.id = ?', [requestId], (err, request) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    // Add to wing members
    db.run(`INSERT OR REPLACE INTO wing_members (wing_id, volunteer_id, role, sort_order) VALUES (?, ?, 'Wing Member', 7)`,
      [id, request.volunteer_id], (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        
        // Update request status
        db.run(`UPDATE wing_join_requests SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [reviewerId, requestId], (err3) => {
            if (err3) return res.status(500).json({ error: err3.message });
            
            // Create notification for the user
            createNotification(request.volunteer_id, 'wing_join_approved', 
              `Your request to join ${request.wing_name} has been approved! Welcome to the wing.`, {
                data: { wingId: parseInt(id), wingName: request.wing_name },
                actorId: reviewerId,
                priority: 'high'
            }).catch(console.error);
            
            res.json({ success: true });
          }
        );
      }
    );
  });
});

// Reject join request
app.put('/api/wings/:id/join-requests/:requestId/reject', (req, res) => {
  const { id, requestId } = req.params;
  const { reviewerId } = req.body;
  
  db.run(`UPDATE wing_join_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [reviewerId, requestId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Get wing posts for management (with search)
app.get('/api/wings/:id/posts/manage', (req, res) => {
  const { id } = req.params;
  const { search } = req.query;
  
  let query = `
    SELECT wp.*, v.full_name as author_name, v.avatar as author_avatar,
           (SELECT COUNT(*) FROM wing_post_reactions WHERE post_id = wp.id) as reaction_count,
           (SELECT COUNT(*) FROM wing_post_comments WHERE post_id = wp.id) as comment_count,
           (SELECT COUNT(*) FROM wing_post_images WHERE post_id = wp.id) as image_count
    FROM wing_posts wp
    JOIN volunteers v ON wp.author_id = v.id
    WHERE wp.wing_id = ?
  `;
  
  const params = [id];
  
  if (search) {
    query += ` AND (wp.content LIKE ? OR v.full_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  
  query += ` ORDER BY wp.created_at DESC`;
  
  db.all(query, params, (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(posts);
  });
});

// Delete post
app.delete('/api/posts/:postId', (req, res) => {
  const { postId } = req.params;
  
  db.run('DELETE FROM wing_posts WHERE id = ?', [postId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Update post (edit)
app.put('/api/posts/:postId', (req, res) => {
  const { postId } = req.params;
  const { content, location } = req.body;
  
  db.run('UPDATE wing_posts SET content = ?, location = ? WHERE id = ?', 
    [content, location || null, postId], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ==================== GROUP CHAT JOIN REQUEST API ====================

// Get group settings
app.get('/api/groups/:id/settings', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT g.*, 
           (SELECT COUNT(*) FROM group_join_requests WHERE group_id = g.id AND status = 'pending') as pending_requests
    FROM group_chats g WHERE g.id = ?
  `, [id], (err, group) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  });
});

// Update group settings (including join_approval_required)
app.put('/api/groups/:id/settings', (req, res) => {
  const { id } = req.params;
  const { name, description, avatar, join_approval_required, allow_member_add } = req.body;
  
  let updates = [];
  let params = [];
  
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (avatar !== undefined) { updates.push('avatar = ?'); params.push(avatar); }
  if (join_approval_required !== undefined) { updates.push('join_approval_required = ?'); params.push(join_approval_required ? 1 : 0); }
  if (allow_member_add !== undefined) { updates.push('allow_member_add = ?'); params.push(allow_member_add ? 1 : 0); }
  
  if (updates.length === 0) return res.json({ success: true });
  
  params.push(id);
  
  db.run(`UPDATE group_chats SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get group join requests
app.get('/api/groups/:id/join-requests', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT gjr.*, v.full_name, v.avatar, v.position, v.wing
    FROM group_join_requests gjr
    JOIN volunteers v ON gjr.user_id = v.id
    WHERE gjr.group_id = ? AND gjr.status = 'pending'
    ORDER BY gjr.requested_at DESC
  `, [id], (err, requests) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(requests || []);
  });
});

// Submit join request
app.post('/api/groups/:id/join-requests', (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  
  // Check if already a member
  db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [id, userId], (err, member) => {
    if (err) return res.status(500).json({ error: err.message });
    if (member) return res.status(400).json({ error: 'Already a member' });
    
    // Check if already requested
    db.get('SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = ?', 
      [id, userId, 'pending'], (reqErr, existing) => {
        if (reqErr) return res.status(500).json({ error: reqErr.message });
        if (existing) return res.status(400).json({ error: 'Request already pending' });
        
        db.run('INSERT INTO group_join_requests (group_id, user_id) VALUES (?, ?)', [id, userId], function(insErr) {
          if (insErr) return res.status(500).json({ error: insErr.message });
          res.json({ success: true, requestId: this.lastID });
        });
      }
    );
  });
});

// Approve join request
app.put('/api/groups/:id/join-requests/:requestId/approve', (req, res) => {
  const { id, requestId } = req.params;
  const { reviewedBy } = req.body;
  
  db.get('SELECT * FROM group_join_requests WHERE id = ? AND group_id = ?', [requestId, id], (err, request) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    
    // Add member to group
    db.run('INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)', 
      [id, request.user_id], (insErr) => {
        if (insErr) return res.status(500).json({ error: insErr.message });
        
        // Update request status
        db.run('UPDATE group_join_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['approved', reviewedBy, requestId], (updErr) => {
            if (updErr) return res.status(500).json({ error: updErr.message });
            
            // Add system message
            db.get('SELECT full_name FROM volunteers WHERE id = ?', [request.user_id], (nameErr, user) => {
              if (!nameErr && user) {
                addGroupSystemMessage(id, `${user.full_name} joined the group`);
              }
            });
            
            res.json({ success: true });
          }
        );
      }
    );
  });
});

// Reject join request
app.put('/api/groups/:id/join-requests/:requestId/reject', (req, res) => {
  const { id, requestId } = req.params;
  const { reviewedBy } = req.body;
  
  db.run('UPDATE group_join_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['rejected', reviewedBy, requestId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ==================== END GROUP CHAT JOIN REQUEST API ====================

// Get or create wing group chat
app.get('/api/wings/:id/group-chat', (req, res) => {
  const { id } = req.params;
  const userId = req.query.userId;
  
  // First check if wing group exists
  db.get('SELECT * FROM group_chats WHERE wing_id = ?', [id], (err, group) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (group) {
      // Group exists, return it
      return res.json({ groupId: group.id, exists: true });
    }
    
    // Group doesn't exist, return null - frontend will create it
    res.json({ groupId: null, exists: false });
  });
});

// Create wing group chat (with all members auto-added)
app.post('/api/wings/:id/group-chat', (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  
  // Get wing info
  db.get('SELECT * FROM wings WHERE id = ?', [id], (err, wing) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!wing) return res.status(404).json({ error: 'Wing not found' });
    
    // Get all wing members with their admin status
    db.all(`
      SELECT wm.volunteer_id, wm.is_admin, wm.sort_order, v.full_name 
      FROM wing_members wm 
      JOIN volunteers v ON wm.volunteer_id = v.id 
      WHERE wm.wing_id = ?
    `, [id], (membersErr, members) => {
      if (membersErr) return res.status(500).json({ error: membersErr.message });
      
      if (members.length === 0) {
        return res.status(400).json({ error: 'Wing has no members' });
      }
      
      // Find the wing admin (sort_order 1 or is_admin = 1)
      const wingAdmin = members.find(m => m.sort_order === 1 || m.is_admin === 1) || members[0];
      
      // Create the group chat
      db.run(
        `INSERT INTO group_chats (name, description, avatar, creator_id, allow_member_add, wing_id) 
         VALUES (?, ?, ?, ?, 0, ?)`,
        [wing.name, wing.bio || wing.description || '', wing.image || '', wingAdmin.volunteer_id, id],
        function(insertErr) {
          if (insertErr) return res.status(500).json({ error: insertErr.message });
          
          const groupId = this.lastID;
          
          // Add all wing members to the group
          const insertStmt = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, ?)');
          
          members.forEach(member => {
            // Wing admins and sort_order 1 become group admins
            const isGroupAdmin = member.is_admin === 1 || member.sort_order === 1 ? 1 : 0;
            insertStmt.run(groupId, member.volunteer_id, isGroupAdmin);
          });
          
          insertStmt.finalize();
          
          // Add system message
          addGroupSystemMessage(groupId, `Welcome to ${wing.name} group chat!`)
            .then(() => {
              res.json({ groupId, created: true });
            })
            .catch(() => {
              res.json({ groupId, created: true });
            });
        }
      );
    });
  });
});

// Sync wing members with group chat (call this when members join/leave wing)
app.post('/api/wings/:id/sync-group-members', (req, res) => {
  const { id } = req.params;
  
  // Get wing group chat
  db.get('SELECT id FROM group_chats WHERE wing_id = ?', [id], (err, group) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!group) return res.json({ synced: false, message: 'No group chat exists for this wing' });
    
    // Get all wing members
    db.all(`
      SELECT wm.volunteer_id, wm.is_admin, wm.sort_order 
      FROM wing_members wm WHERE wm.wing_id = ?
    `, [id], (membersErr, wingMembers) => {
      if (membersErr) return res.status(500).json({ error: membersErr.message });
      
      // Add missing members to group chat
      const insertStmt = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, ?)');
      
      wingMembers.forEach(member => {
        const isGroupAdmin = member.is_admin === 1 || member.sort_order === 1 ? 1 : 0;
        insertStmt.run(group.id, member.volunteer_id, isGroupAdmin);
      });
      
      insertStmt.finalize();
      
      // Update admin status for existing members
      wingMembers.forEach(member => {
        const isGroupAdmin = member.is_admin === 1 || member.sort_order === 1 ? 1 : 0;
        db.run('UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?', 
          [isGroupAdmin, group.id, member.volunteer_id]);
      });
      
      res.json({ synced: true, groupId: group.id });
    });
  });
});

// ==================== END WING SETTINGS API ====================

// ==================== END WINGS API ====================

// ==================== DONATIONS API ====================

// Get pending donations for admin approval
app.get('/api/donations/pending', (req, res) => {
  db.all(`
    SELECT 
      d.*,
      c.title as campaign_title,
      c.image as campaign_image
    FROM donations d
    INNER JOIN campaigns c ON d.campaign_id = c.id
    WHERE d.status = 'pending'
    ORDER BY d.created_at DESC
  `, (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations || []);
  });
});

// Approve a donation
app.post('/api/donations/:id/approve', (req, res) => {
  const { id } = req.params;

  db.get(`
    SELECT d.*, c.title as campaign_title 
    FROM donations d 
    LEFT JOIN campaigns c ON d.campaign_id = c.id 
    WHERE d.id = ?
  `, [id], (err, donation) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    // Update donation status to approved
    db.run(`
      UPDATE donations 
      SET status = 'approved', verified_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Notify the donor if they have a volunteer_id
      if (donation.volunteer_id) {
        createNotification(donation.volunteer_id, 'donation_approved',
          `Your donation of ৳${donation.amount} to "${donation.campaign_title}" has been approved. Thank you for your contribution!`, {
            data: { 
              donationId: donation.id, 
              campaignId: donation.campaign_id,
              amount: donation.amount 
            },
            priority: 'normal'
        }).catch(console.error);
      }
      
      // Notify referrer if exists
      if (donation.referrer_id) {
        createNotification(donation.referrer_id, 'referral_donation_approved',
          `A donation of ৳${donation.amount} you referred to "${donation.campaign_title}" has been approved!`, {
            data: { 
              donationId: donation.id, 
              campaignId: donation.campaign_id,
              amount: donation.amount,
              donorName: donation.donor_name
            },
            priority: 'normal'
        }).catch(console.error);
      }
      
      // Log the approval action
      db.run(`
        INSERT INTO access_logs (action_type, action_description, actor_id, target_id, target_type, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `, ['donation_approved', `Approved donation of ৳${donation.amount}`, donation.volunteer_id || 0, id, 'donation', 
          JSON.stringify({ donationId: id, amount: donation.amount, campaignId: donation.campaign_id })]);

      res.json({ message: 'Donation approved successfully' });
    });
  });
});

// Reject a donation
app.post('/api/donations/:id/reject', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM donations WHERE id = ?', [id], (err, donation) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    // Update donation status to rejected and reduce campaign raised amount
    db.run(`
      UPDATE donations 
      SET status = 'rejected', verified_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Reduce campaign raised amount
      db.run(`
        UPDATE campaigns 
        SET raised = COALESCE(raised, 0) - ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [donation.amount, donation.campaign_id], (updateErr) => {
        if (updateErr) {
          console.error('Failed to update campaign raised amount after rejection:', updateErr);
        }
      });

      res.json({ message: 'Donation rejected' });
    });
  });
});

// Get donations for a campaign (including all statuses for admin view)
app.get('/api/campaigns/:id/donations/all', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT 
      d.*,
      v.full_name as volunteer_name,
      v.avatar
    FROM donations d
    LEFT JOIN volunteers v ON d.volunteer_id = v.id
    WHERE d.campaign_id = ?
    ORDER BY 
      CASE WHEN d.status = 'pending' THEN 1 
           WHEN d.status = 'approved' THEN 2 
           WHEN d.status = 'rejected' THEN 3 
           ELSE 4 END,
      d.created_at DESC
  `, [id], (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations || []);
  });
});

// Get donations for a campaign
app.get('/api/campaigns/:id/donations', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT 
      d.*,
      v.full_name as volunteer_name,
      v.avatar
    FROM donations d
    LEFT JOIN volunteers v ON d.volunteer_id = v.id
    WHERE d.campaign_id = ? AND d.status = 'approved'
    ORDER BY d.created_at DESC
  `, [id], (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations || []);
  });
});

// Get all donations for website transparency page
app.get('/api/donations/all', (req, res) => {
  const query = `
    SELECT d.*, c.title as campaign_title, c.wing as campaign_wing, v.full_name as volunteer_name
    FROM donations d
    LEFT JOIN campaigns c ON d.campaign_id = c.id
    LEFT JOIN volunteers v ON d.volunteer_id = v.id
    ORDER BY d.created_at DESC
  `
  
  db.all(query, [], (err, donations) => {
    if (err) {
      console.error('Database error:', err)
      res.status(500).json({ error: 'Failed to fetch donations' })
      return
    }
    
    // Calculate total approved donations amount
    const totalDonations = donations
      .filter(d => d.status === 'approved')
      .reduce((sum, d) => sum + d.amount, 0)
    
    res.json({
      donations,
      totalDonations
    })
  })
})

// Submit a new donation
app.post('/api/donations', (req, res) => {
  console.log('[DEBUG] Donation endpoint hit');
  console.log('[DEBUG] Request body:', req.body);
  
  const { 
    campaignId, 
    donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous,
    volunteerId,
    referrerId
  } = req.body;

  // Validate required fields
  if (!campaignId || !amount || !paymentMethod || !transactionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isAnonymous && !donorName?.trim()) {
    return res.status(400).json({ error: 'Donor name is required for non-anonymous donations' });
  }

  // Insert donation record
  db.run(`
    INSERT INTO donations (
      campaign_id, donor_name, phone_number, amount, payment_method, 
      transaction_id, is_anonymous, volunteer_id, referrer_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `, [
    campaignId, 
    isAnonymous ? 'Anonymous' : donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous ? 1 : 0,
    volunteerId || null,
    referrerId || null
  ], function(err) {
    if (err) {
      console.error('Failed to insert donation:', err);
      return res.status(500).json({ error: 'Failed to record donation' });
    }

    // Update campaign raised amount (pending verification)
    db.run(`
      UPDATE campaigns 
      SET raised = COALESCE(raised, 0) + ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [amount, campaignId], (updateErr) => {
      if (updateErr) {
        console.error('Failed to update campaign raised amount:', updateErr);
      }
    });

    res.json({ 
      id: this.lastID, 
      message: 'Donation recorded successfully. It will be verified soon.',
      status: 'pending'
    });
  });
});

// Verify/approve a donation (admin only)
app.post('/api/donations/:id/verify', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'verified' or 'rejected'

  db.run(`
    UPDATE donations 
    SET status = ?, verified_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `, [status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Donation not found' });

    // If verified, update referrer's collected amount and points
    if (status === 'verified') {
      db.get('SELECT referrer_id, amount FROM donations WHERE id = ?', [id], (err2, donation) => {
        if (!err2 && donation && donation.referrer_id) {
          // Update referrer's total_collected and donation_points
          const points = Math.floor(donation.amount / 100); // 1 point per 100 taka collected
          db.run(`
            UPDATE volunteers 
            SET total_collected = COALESCE(total_collected, 0) + ?,
                donation_points = COALESCE(donation_points, 0) + ?
            WHERE id = ?
          `, [donation.amount, points, donation.referrer_id]);
        }
      });
    }

    res.json({ message: `Donation ${status} successfully` });
  });
});

// Public donation endpoint (no login required, with referrer)
app.post('/api/public/donate', (req, res) => {
  const { 
    campaignId, 
    directAidId,
    donationType,
    donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous,
    referrerId
  } = req.body;

  // Validate required fields
  if ((!campaignId && !directAidId) || !amount || !paymentMethod || !transactionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isAnonymous && !donorName?.trim()) {
    return res.status(400).json({ error: 'Donor name is required for non-anonymous donations' });
  }

  // Insert donation record
  db.run(`
    INSERT INTO donations (
      campaign_id, direct_aid_id, donation_type, donor_name, phone_number, amount, payment_method, 
      transaction_id, is_anonymous, referrer_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `, [
    campaignId || null, 
    directAidId || null,
    donationType || 'campaign',
    isAnonymous ? 'Anonymous' : donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous ? 1 : 0,
    referrerId || null
  ], function(err) {
    if (err) {
      console.error('Failed to insert public donation:', err);
      return res.status(500).json({ error: 'Failed to record donation' });
    }

    res.json({ 
      id: this.lastID, 
      message: 'Thank you! Your donation has been recorded and will be verified soon.',
      status: 'pending'
    });
  });
});

// Get campaign/direct aid info for public donation page
app.get('/api/public/campaign/:id', (req, res) => {
  const { id } = req.params;
  db.get(`
    SELECT c.*, v.full_name as host_name, v.avatar as host_avatar
    FROM campaigns c
    LEFT JOIN volunteers v ON c.host_id = v.id
    WHERE c.id = ? AND c.status = 'Active'
  `, [id], (err, campaign) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  });
});

app.get('/api/public/direct-aid/:id', (req, res) => {
  const { id } = req.params;
  db.get(`
    SELECT da.*, v.full_name as requester_name, v.avatar as requester_avatar
    FROM direct_aids da
    LEFT JOIN volunteers v ON da.requester_id = v.id
    WHERE da.id = ? AND da.status = 'active'
  `, [id], (err, aid) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!aid) return res.status(404).json({ error: 'Direct aid not found' });
    res.json(aid);
  });
});

// Get referrer info for public donation page
app.get('/api/public/referrer/:id', (req, res) => {
  const { id } = req.params;
  db.get(`
    SELECT id, full_name, avatar, wing, position
    FROM volunteers WHERE id = ?
  `, [id], (err, volunteer) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!volunteer) return res.status(404).json({ error: 'Referrer not found' });
    res.json(volunteer);
  });
});

// Get user's donation stats
app.get('/api/volunteers/:id/donation-stats', (req, res) => {
  const { id } = req.params;
  
  const stats = {};
  
  // Get donations made by user this month
  db.get(`
    SELECT COALESCE(SUM(amount), 0) as thisMonth
    FROM donations 
    WHERE volunteer_id = ? 
    AND status = 'approved'
    AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `, [id], (err, thisMonthResult) => {
    if (err) return res.status(500).json({ error: err.message });
    stats.donatedThisMonth = thisMonthResult?.thisMonth || 0;
    
    // Get all-time donations by user
    db.get(`
      SELECT COALESCE(SUM(amount), 0) as allTime
      FROM donations 
      WHERE volunteer_id = ? AND status = 'approved'
    `, [id], (err2, allTimeResult) => {
      if (err2) return res.status(500).json({ error: err2.message });
      stats.donatedAllTime = allTimeResult?.allTime || 0;
      
      // Get total collected via referrals
      db.get(`
        SELECT COALESCE(SUM(amount), 0) as collected
        FROM donations 
        WHERE referrer_id = ? AND status = 'approved'
      `, [id], (err3, collectedResult) => {
        if (err3) return res.status(500).json({ error: err3.message });
        stats.totalCollected = collectedResult?.collected || 0;
        
        // Get collected this month
        db.get(`
          SELECT COALESCE(SUM(amount), 0) as collectedThisMonth
          FROM donations 
          WHERE referrer_id = ? 
          AND status = 'approved'
          AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
        `, [id], (err4, collectedMonthResult) => {
          if (err4) return res.status(500).json({ error: err4.message });
          stats.collectedThisMonth = collectedMonthResult?.collectedThisMonth || 0;
          
          res.json(stats);
        });
      });
    });
  });
});

// Get user's donation transactions (both donated and collected)
app.get('/api/volunteers/:id/donations', (req, res) => {
  const { id } = req.params;
  const { type } = req.query; // 'donated', 'collected', or 'all'
  
  // Get donations from campaigns
  let campaignQuery = `
    SELECT d.id, d.campaign_id, NULL as direct_aid_id, d.donor_name, d.phone_number, 
           d.amount, d.payment_method, d.transaction_id, d.is_anonymous, 
           d.volunteer_id, d.referrer_id, d.status, d.created_at,
           'campaign' as donation_type,
           c.title as campaign_title, c.image as campaign_image,
           NULL as direct_aid_title,
           r.full_name as referrer_name
    FROM donations d
    LEFT JOIN campaigns c ON d.campaign_id = c.id
    LEFT JOIN volunteers r ON d.referrer_id = r.id
    WHERE 1=1
  `;
  
  // Get donations from direct aids
  let directAidQuery = `
    SELECT dad.id, NULL as campaign_id, dad.direct_aid_id, dad.donor_name, dad.phone_number,
           dad.amount, dad.payment_method, dad.transaction_id, dad.is_anonymous,
           dad.volunteer_id, NULL as referrer_id, dad.status, dad.created_at,
           'directaid' as donation_type,
           NULL as campaign_title, NULL as campaign_image,
           da.title as direct_aid_title,
           NULL as referrer_name
    FROM direct_aid_donations dad
    LEFT JOIN direct_aids da ON dad.direct_aid_id = da.id
    WHERE 1=1
  `;
  
  if (type === 'donated') {
    campaignQuery += ` AND d.volunteer_id = ${id}`;
    directAidQuery += ` AND dad.volunteer_id = ${id}`;
  } else if (type === 'collected') {
    campaignQuery += ` AND d.referrer_id = ${id}`;
    directAidQuery += ` AND 0`; // No referrer for direct aid
  } else {
    campaignQuery += ` AND (d.volunteer_id = ${id} OR d.referrer_id = ${id})`;
    directAidQuery += ` AND dad.volunteer_id = ${id}`;
  }
  
  const combinedQuery = `
    SELECT * FROM (
      ${campaignQuery}
      UNION ALL
      ${directAidQuery}
    ) combined
    ORDER BY created_at DESC
    LIMIT 100
  `;
  
  db.all(combinedQuery, [], (err, donations) => {
    if (err) {
      console.error('Error fetching donations:', err);
      return res.status(500).json({ error: err.message });
    }
    
    // Add type indicator for each donation
    const processed = (donations || []).map(d => ({
      ...d,
      transactionType: d.volunteer_id == id ? 'donated' : 'collected'
    }));
    
    res.json(processed);
  });
});

// ==================== END DONATIONS API ====================

// ==================== LEADERBOARD API ====================

// Get global statistics
app.get('/api/statistics', (req, res) => {
  const stats = {};
  
  // Get total volunteers
  db.get('SELECT COUNT(*) as count FROM volunteers', (err, volResult) => {
    if (err) return res.status(500).json({ error: err.message });
    stats.totalVolunteers = volResult?.count || 0;
    
    // Get total donations (approved only)
    db.get('SELECT COALESCE(SUM(amount), 0) as total FROM donations WHERE status = "approved"', (donErr, donResult) => {
      if (donErr) return res.status(500).json({ error: donErr.message });
      stats.totalDonations = donResult?.total || 0;
      
      // Get total lives impacted from campaigns AND volunteers
      db.get('SELECT COALESCE(SUM(lives_impacted), 0) as total FROM campaigns', (livesErr, livesResult) => {
        if (livesErr) return res.status(500).json({ error: livesErr.message });
        const campaignLives = livesResult?.total || 0;
        
        db.get('SELECT COALESCE(SUM(lives_impacted), 0) as total FROM volunteers', (volLivesErr, volLivesResult) => {
          if (volLivesErr) return res.status(500).json({ error: volLivesErr.message });
          stats.livesImpacted = campaignLives + (volLivesResult?.total || 0);
        
          // Get total wings
          db.get('SELECT COUNT(*) as count FROM wings WHERE approval_status = "approved"', (wingsErr, wingsResult) => {
            if (wingsErr) return res.status(500).json({ error: wingsErr.message });
            stats.totalWings = wingsResult?.count || 0;
          
            // Get total hours given
            db.get('SELECT COALESCE(SUM(total_hours), 0) + COALESCE(SUM(hours_given), 0) as total FROM volunteers', (hoursErr, hoursResult) => {
              if (hoursErr) return res.status(500).json({ error: hoursErr.message });
              stats.totalHours = hoursResult?.total || 0;
            
              res.json(stats);
            });
          });
        });
      });
    });
  });
});

// Get monthly leaderboard with pagination
app.get('/api/leaderboard', (req, res) => {
  const { month, year, limit = 20, offset = 0, userId } = req.query;
  
  // Get current month/year if not specified
  const now = new Date();
  const targetMonth = month || (now.getMonth() + 1);
  const targetYear = year || now.getFullYear();
  const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const endDate = `${targetYear}-${String(parseInt(targetMonth) + 1).padStart(2, '0')}-01`;
  
  // First get the logged-in user's rank if userId is provided
  let userRankData = null;
  
  const getLeaderboard = () => {
    // Calculate monthly stats for each volunteer with proper score calculation
    db.all(`
      SELECT 
        v.id,
        v.full_name,
        v.avatar,
        v.wing,
        v.digital_id,
        v.position,
        v.respect_points,
        v.total_hours,
        v.hours_given,
        v.lives_impacted,
        v.points,
        v.total_donated,
        v.total_collected,
        v.donation_points,
        COALESCE((
          SELECT SUM(amount) 
          FROM donations d 
          WHERE (d.donor_name = v.full_name OR d.volunteer_id = v.id)
          AND d.status = 'approved'
          AND d.created_at >= ? AND d.created_at < ?
        ), 0) as monthly_donations,
        COALESCE((
          SELECT SUM(amount) 
          FROM donations d 
          WHERE d.referrer_id = v.id
          AND d.status IN ('approved', 'verified')
          AND d.created_at >= ? AND d.created_at < ?
        ), 0) as monthly_collected,
        COALESCE((
          SELECT COUNT(DISTINCT a.ally_id) 
          FROM allies a 
          WHERE a.volunteer_id = v.id
          AND a.created_at >= ? AND a.created_at < ?
        ), 0) as monthly_referrals,
        COALESCE((
          SELECT SUM(ct.hours) 
          FROM campaign_team ct 
          INNER JOIN campaigns c ON ct.campaign_id = c.id
          WHERE ct.volunteer_id = v.id 
          AND ct.approval_status = 'approved'
          AND c.created_at >= ? AND c.created_at < ?
        ), 0) as monthly_hours,
        COALESCE(v.total_hours, 0) + COALESCE(v.hours_given, 0) as all_time_hours,
        COALESCE(v.respect_points, 0) + COALESCE(v.points, 0) + COALESCE(v.donation_points, 0) as total_respect,
        (
          COALESCE((
            SELECT SUM(amount) 
            FROM donations d 
            WHERE (d.donor_name = v.full_name OR d.volunteer_id = v.id)
            AND d.status = 'approved'
            AND d.created_at >= ? AND d.created_at < ?
          ), 0) * 0.1
        ) + 
        (
          COALESCE((
            SELECT SUM(amount) 
            FROM donations d 
            WHERE d.referrer_id = v.id
            AND d.status IN ('approved', 'verified')
            AND d.created_at >= ? AND d.created_at < ?
          ), 0) * 0.05
        ) +
        COALESCE(v.respect_points, 0) + COALESCE(v.points, 0) + COALESCE(v.donation_points, 0) +
        (
          COALESCE((
            SELECT SUM(ct.hours) 
            FROM campaign_team ct 
            INNER JOIN campaigns c ON ct.campaign_id = c.id
            WHERE ct.volunteer_id = v.id 
            AND ct.approval_status = 'approved'
            AND c.created_at >= ? AND c.created_at < ?
          ), 0) * 10
        ) as calculated_score
      FROM volunteers v
      WHERE v.status = 'Active'
      ORDER BY calculated_score DESC
      LIMIT ? OFFSET ?
    `, [
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      parseInt(limit), parseInt(offset)
    ], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Map results with consistent score
      const leaderboard = (rows || []).map((v, index) => {
        return {
          ...v,
          rank: parseInt(offset) + index + 1,
          score: Math.round(v.calculated_score || 0),
          monthly_donations: v.monthly_donations,
          monthly_collected: v.monthly_collected,
          respect_points: v.total_respect,
          monthly_hours: v.monthly_hours
        };
      });
      
      // Get total count for pagination
      db.get('SELECT COUNT(*) as count FROM volunteers WHERE status = "Active"', (countErr, countResult) => {
        if (countErr) return res.status(500).json({ error: countErr.message });
        
        res.json({
          leaderboard,
          userRank: userRankData,
          total: countResult?.count || 0,
          month: targetMonth,
          year: targetYear,
          hasMore: (parseInt(offset) + leaderboard.length) < (countResult?.count || 0)
        });
      });
    });
  };
  
  // Get user's rank first if userId provided
  if (userId) {
    db.all(`
      SELECT 
        v.id,
        v.full_name,
        v.avatar,
        v.wing,
        v.digital_id,
        v.position,
        COALESCE((
          SELECT SUM(amount) 
          FROM donations d 
          WHERE (d.donor_name = v.full_name OR d.volunteer_id = v.id)
          AND d.status = 'approved'
          AND d.created_at >= ? AND d.created_at < ?
        ), 0) as monthly_donations,
        COALESCE((
          SELECT COUNT(DISTINCT a.ally_id) 
          FROM allies a 
          WHERE a.volunteer_id = v.id
          AND a.created_at >= ? AND a.created_at < ?
        ), 0) as monthly_referrals,
        COALESCE((
          SELECT SUM(ct.hours) 
          FROM campaign_team ct 
          INNER JOIN campaigns c ON ct.campaign_id = c.id
          WHERE ct.volunteer_id = v.id 
          AND ct.approval_status = 'approved'
          AND c.created_at >= ? AND c.created_at < ?
        ), 0) as monthly_hours,
        COALESCE(v.total_hours, 0) + COALESCE(v.hours_given, 0) as all_time_hours,
        COALESCE(v.respect_points, 0) + COALESCE(v.points, 0) as all_time_points
      FROM volunteers v
      WHERE v.status = 'Active'
      ORDER BY 
        (COALESCE((
          SELECT SUM(amount) 
          FROM donations d 
          WHERE (d.donor_name = v.full_name OR d.volunteer_id = v.id)
          AND d.status = 'approved'
          AND d.created_at >= ? AND d.created_at < ?
        ), 0) * 0.1) +
        (COALESCE(v.respect_points, 0) + COALESCE(v.points, 0)) +
        (COALESCE((
          SELECT SUM(ct.hours) 
          FROM campaign_team ct 
          INNER JOIN campaigns c ON ct.campaign_id = c.id
          WHERE ct.volunteer_id = v.id 
          AND ct.approval_status = 'approved'
          AND c.created_at >= ? AND c.created_at < ?
        ), 0) * 10) DESC
    `, [
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate,
      startDate, endDate
    ], (rankErr, allRows) => {
      if (!rankErr && allRows) {
        const userIndex = allRows.findIndex(v => v.id.toString() === userId.toString());
        if (userIndex !== -1) {
          const userData = allRows[userIndex];
          const totalRespect = userData.all_time_points || 0;
          const score = Math.round(
            (userData.monthly_donations * 0.1) + 
            totalRespect + 
            (userData.monthly_hours * 10)
          );
          userRankData = {
            ...userData,
            rank: userIndex + 1,
            score,
            monthly_donations: userData.monthly_donations,
            respect_points: totalRespect,
            monthly_hours: userData.monthly_hours
          };
        }
      }
      getLeaderboard();
    });
  } else {
    getLeaderboard();
  }
});

// Get organization structure - Central Committee + Wing Chiefs
app.get('/api/org-structure', (req, res) => {
  const centralPositions = ['Chief Coordinator', 'Executive Director', 'Director of Programs', 'President', 'Vice President', 'Secretary', 'Treasurer', 'General Secretary'];
  const wingChiefRoles = ['Wing Chief Executive', 'Wing President', 'Wing Chief', 'President', 'Chief Coordinator'];
  
  // Get Central Committee members (volunteers with executive positions)
  db.all(`
    SELECT 
      v.id,
      v.full_name,
      v.avatar,
      v.position,
      v.digital_id,
      v.total_hours,
      v.hours_given,
      v.lives_impacted,
      v.respect_points,
      v.points,
      'central' as committee_type,
      0 as sort_order
    FROM volunteers v
    WHERE v.position IN (${centralPositions.map(() => '?').join(',')})
    OR v.position LIKE '%Coordinator%'
    OR v.position LIKE '%Director%'
    OR v.position LIKE '%President%'
    ORDER BY 
      CASE 
        WHEN v.position LIKE '%Chief%' THEN 1
        WHEN v.position LIKE '%President%' THEN 2
        WHEN v.position LIKE '%Director%' THEN 3
        WHEN v.position LIKE '%Secretary%' THEN 4
        WHEN v.position LIKE '%Treasurer%' THEN 5
        ELSE 6
      END
  `, centralPositions, (centralErr, centralMembers) => {
    if (centralErr) return res.status(500).json({ error: centralErr.message });
    
    // Get Wing Chiefs (top role from each wing)
    db.all(`
      SELECT 
        v.id,
        v.full_name,
        v.avatar,
        v.position,
        v.digital_id,
        v.total_hours,
        v.hours_given,
        v.lives_impacted,
        v.respect_points,
        v.points,
        wm.role as wing_role,
        w.id as wing_id,
        w.name as wing_name,
        w.image as wing_image,
        'wing' as committee_type,
        wm.sort_order
      FROM wing_members wm
      INNER JOIN volunteers v ON wm.volunteer_id = v.id
      INNER JOIN wings w ON wm.wing_id = w.id
      WHERE w.approval_status = 'approved'
      AND wm.sort_order = (
        SELECT MIN(wm2.sort_order) 
        FROM wing_members wm2 
        WHERE wm2.wing_id = wm.wing_id
      )
      ORDER BY w.name
    `, [], (wingErr, wingChiefs) => {
      if (wingErr) return res.status(500).json({ error: wingErr.message });
      
      // Get all wing committee members grouped by wing
      db.all(`
        SELECT 
          v.id,
          v.full_name,
          v.avatar,
          v.position,
          v.digital_id,
          v.total_hours,
          v.hours_given,
          v.lives_impacted,
          v.respect_points,
          v.points,
          wm.role as wing_role,
          w.id as wing_id,
          w.name as wing_name,
          w.image as wing_image,
          'wing_member' as committee_type,
          wm.sort_order
        FROM wing_members wm
        INNER JOIN volunteers v ON wm.volunteer_id = v.id
        INNER JOIN wings w ON wm.wing_id = w.id
        WHERE w.approval_status = 'approved'
        ORDER BY w.name, wm.sort_order
      `, [], (allWingErr, allWingMembers) => {
        if (allWingErr) return res.status(500).json({ error: allWingErr.message });
        
        // Group wing members by wing
        const wingCommittees = {};
        allWingMembers.forEach(member => {
          if (!wingCommittees[member.wing_id]) {
            wingCommittees[member.wing_id] = {
              wing_id: member.wing_id,
              wing_name: member.wing_name,
              wing_image: member.wing_image,
              members: []
            };
          }
          wingCommittees[member.wing_id].members.push(member);
        });
        
        res.json({
          centralCommittee: centralMembers || [],
          wingChiefs: wingChiefs || [],
          wingCommittees: Object.values(wingCommittees)
        });
      });
    });
  });
});

// ==================== END LEADERBOARD API ====================

// ==================== NOTIFICATIONS API ====================

// Helper function to create notifications
const createNotification = async (userId, type, message, options = {}) => {
  return new Promise((resolve, reject) => {
    const {
      title = null,
      data = null,
      actorId = null,
      actorName = null,
      actorAvatar = null,
      priority = 'normal',
      expiresAt = null
    } = options;

    db.run(`
      INSERT INTO notifications (user_id, type, title, message, data, actor_id, actor_name, actor_avatar, priority, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      type,
      title,
      message,
      typeof data === 'object' ? JSON.stringify(data) : data,
      actorId,
      actorName,
      actorAvatar,
      priority,
      expiresAt
    ], function(err) {
      if (err) {
        console.error('Failed to create notification:', err);
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
};

// Helper to create notifications for multiple users
const createBulkNotifications = async (userIds, type, message, options = {}) => {
  const promises = userIds.map(userId => createNotification(userId, type, message, options));
  return Promise.allSettled(promises);
};

// Notification type to category mapping
const notificationCategories = {
  'ally_added': 'social',
  'ally_request': 'social',
  'ally_accepted': 'social',
  'profile_view': 'social',
  'follow': 'social',
  'mention': 'social',
  'tagged': 'social',
  'message': 'messages',
  'message_image': 'messages',
  'group_message': 'messages',
  'wing_group_message': 'messages',
  'message_reaction': 'messages',
  'donation_approved': 'donations',
  'donation_rejected': 'donations',
  'referral_donation_approved': 'donations',
  'donation_received': 'donations',
  'donation_goal_reached': 'donations',
  'donation_milestone': 'donations',
  'campaign_join_approved': 'campaigns',
  'campaign_join_rejected': 'campaigns',
  'campaign_invite': 'campaigns',
  'campaign_update': 'campaigns',
  'campaign_completed': 'campaigns',
  'campaign_reminder': 'campaigns',
  'campaign_role_assigned': 'campaigns',
  'campaign_hours_logged': 'campaigns',
  'wing_join_approved': 'wings',
  'wing_join_rejected': 'wings',
  'wing_invite': 'wings',
  'wing_post': 'wings',
  'wing_post_reaction': 'wings',
  'wing_post_comment': 'wings',
  'wing_role_changed': 'wings',
  'wing_announcement': 'wings',
  'wing_member_joined': 'wings',
  'badge_earned': 'badges',
  'badge_milestone': 'badges',
  'level_up': 'badges',
  'achievement_unlocked': 'badges',
  'announcement': 'system',
  'system_update': 'system',
  'account_update': 'system',
  'security_alert': 'system',
  'reminder': 'system',
  'welcome': 'system',
  'course_enrolled': 'system',
  'course_completed': 'system',
  'certificate_issued': 'system',
};

// Get notifications for a user
app.get('/api/notifications/:userId', (req, res) => {
  const { userId } = req.params;
  const { limit = 20, offset = 0, unread, category, type } = req.query;

  let query = `
    SELECT n.*
    FROM notifications n
    WHERE n.user_id = ? AND n.is_archived = 0
  `;
  const params = [userId];

  if (unread === 'true') {
    query += ` AND n.is_read = 0`;
  }

  if (category) {
    const types = Object.entries(notificationCategories)
      .filter(([_, cat]) => cat === category)
      .map(([type]) => type);
    if (types.length > 0) {
      query += ` AND n.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
  }

  if (type) {
    query += ` AND n.type = ?`;
    params.push(type);
  }

  // Remove expired notifications
  query += ` AND (n.expires_at IS NULL OR n.expires_at > datetime('now'))`;

  query += ` ORDER BY n.created_at DESC LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  db.all(query, params, (err, notifications) => {
    if (err) return res.status(500).json({ error: err.message });

    // Get unread count
    db.get(`
      SELECT COUNT(*) as count 
      FROM notifications 
      WHERE user_id = ? AND is_read = 0 AND is_archived = 0
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `, [userId], (countErr, countResult) => {
      if (countErr) return res.status(500).json({ error: countErr.message });

      // Check if there are more
      db.get(`
        SELECT COUNT(*) as total 
        FROM notifications 
        WHERE user_id = ? AND is_archived = 0
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      `, [userId], (totalErr, totalResult) => {
        res.json({
          notifications: notifications || [],
          unreadCount: countResult?.count || 0,
          total: totalResult?.total || 0,
          hasMore: parseInt(offset) + notifications.length < (totalResult?.total || 0)
        });
      });
    });
  });
});

// Get unread notification count
app.get('/api/notifications/:userId/count', (req, res) => {
  const { userId } = req.params;

  db.get(`
    SELECT COUNT(*) as count 
    FROM notifications 
    WHERE user_id = ? AND is_read = 0 AND is_archived = 0
    AND (expires_at IS NULL OR expires_at > datetime('now'))
  `, [userId], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ count: result?.count || 0 });
  });
});

// Create a notification
app.post('/api/notifications', async (req, res) => {
  const { userId, type, message, title, data, actorId, priority } = req.body;

  if (!userId || !type || !message) {
    return res.status(400).json({ error: 'userId, type, and message are required' });
  }

  try {
    // Get actor info if actorId provided
    let actorName = null;
    let actorAvatar = null;
    
    if (actorId) {
      const actor = await new Promise((resolve, reject) => {
        db.get('SELECT full_name, avatar FROM volunteers WHERE id = ?', [actorId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (actor) {
        actorName = actor.full_name;
        actorAvatar = actor.avatar;
      }
    }

    const notificationId = await createNotification(userId, type, message, {
      title,
      data,
      actorId,
      actorName,
      actorAvatar,
      priority
    });

    res.json({ success: true, id: notificationId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create bulk notifications (for announcements, etc.)
app.post('/api/notifications/bulk', async (req, res) => {
  const { userIds, type, message, title, data, actorId, priority } = req.body;

  if (!userIds || !Array.isArray(userIds) || !type || !message) {
    return res.status(400).json({ error: 'userIds array, type, and message are required' });
  }

  try {
    let actorName = null;
    let actorAvatar = null;
    
    if (actorId) {
      const actor = await new Promise((resolve, reject) => {
        db.get('SELECT full_name, avatar FROM volunteers WHERE id = ?', [actorId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (actor) {
        actorName = actor.full_name;
        actorAvatar = actor.avatar;
      }
    }

    const results = await createBulkNotifications(userIds, type, message, {
      title,
      data,
      actorId,
      actorName,
      actorAvatar,
      priority
    });

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    res.json({ success: true, created: successful, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
app.put('/api/notifications/:notificationId/read', (req, res) => {
  const { notificationId } = req.params;

  db.run(`
    UPDATE notifications SET is_read = 1 WHERE id = ?
  `, [notificationId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Mark all notifications as read for a user
app.put('/api/notifications/:userId/read-all', (req, res) => {
  const { userId } = req.params;

  db.run(`
    UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0
  `, [userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
});

// Delete a notification
app.delete('/api/notifications/:notificationId', (req, res) => {
  const { notificationId } = req.params;

  db.run(`DELETE FROM notifications WHERE id = ?`, [notificationId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Clear all notifications for a user
app.delete('/api/notifications/:userId/clear-all', (req, res) => {
  const { userId } = req.params;

  db.run(`DELETE FROM notifications WHERE user_id = ?`, [userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// Archive old notifications (can be called periodically)
app.post('/api/notifications/archive-old', (req, res) => {
  const { daysOld = 30 } = req.body;

  db.run(`
    UPDATE notifications 
    SET is_archived = 1 
    WHERE created_at < datetime('now', '-' || ? || ' days')
    AND is_archived = 0
  `, [daysOld], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, archived: this.changes });
  });
});

// Get notification settings for a user
app.get('/api/notification-settings/:userId', (req, res) => {
  const { userId } = req.params;

  db.get(`SELECT * FROM notification_settings WHERE user_id = ?`, [userId], (err, settings) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Return default settings if none exist
    if (!settings) {
      return res.json({
        user_id: parseInt(userId),
        push_enabled: 1,
        email_enabled: 0,
        sound_enabled: 1,
        vibrate_enabled: 1,
        social_notifications: 1,
        message_notifications: 1,
        donation_notifications: 1,
        campaign_notifications: 1,
        wing_notifications: 1,
        badge_notifications: 1,
        system_notifications: 1,
        quiet_hours_start: null,
        quiet_hours_end: null
      });
    }
    
    res.json(settings);
  });
});

// Update notification settings
app.put('/api/notification-settings/:userId', (req, res) => {
  const { userId } = req.params;
  const settings = req.body;

  // Check if settings exist
  db.get(`SELECT id FROM notification_settings WHERE user_id = ?`, [userId], (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });

    if (existing) {
      // Update existing settings
      const updates = [];
      const values = [];
      
      const allowedFields = [
        'push_enabled', 'email_enabled', 'sound_enabled', 'vibrate_enabled',
        'social_notifications', 'message_notifications', 'donation_notifications',
        'campaign_notifications', 'wing_notifications', 'badge_notifications',
        'system_notifications', 'quiet_hours_start', 'quiet_hours_end'
      ];

      allowedFields.forEach(field => {
        if (settings[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(settings[field]);
        }
      });

      if (updates.length === 0) {
        return res.json({ success: true, message: 'No changes made' });
      }

      values.push(userId);
      
      db.run(`
        UPDATE notification_settings 
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    } else {
      // Create new settings
      db.run(`
        INSERT INTO notification_settings (
          user_id, push_enabled, email_enabled, sound_enabled, vibrate_enabled,
          social_notifications, message_notifications, donation_notifications,
          campaign_notifications, wing_notifications, badge_notifications,
          system_notifications, quiet_hours_start, quiet_hours_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        settings.push_enabled ?? 1,
        settings.email_enabled ?? 0,
        settings.sound_enabled ?? 1,
        settings.vibrate_enabled ?? 1,
        settings.social_notifications ?? 1,
        settings.message_notifications ?? 1,
        settings.donation_notifications ?? 1,
        settings.campaign_notifications ?? 1,
        settings.wing_notifications ?? 1,
        settings.badge_notifications ?? 1,
        settings.system_notifications ?? 1,
        settings.quiet_hours_start ?? null,
        settings.quiet_hours_end ?? null
      ], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
      });
    }
  });
});

// ==================== END NOTIFICATIONS API ====================

// ==================== ACCESS SETTINGS API ====================

// Get access settings for a user/role
app.get('/api/access-settings', (req, res) => {
  const { userId, roleType } = req.query;
  const roleId = req.query.roleId && req.query.roleId !== '' ? req.query.roleId : null;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const query = roleId 
    ? `SELECT permissions FROM access_settings WHERE user_id = ? AND role_type = ? AND role_id = ?`
    : `SELECT permissions FROM access_settings WHERE user_id = ? AND role_type = ? AND role_id IS NULL`;
  
  const params = roleId ? [userId, roleType || 'user', roleId] : [userId, roleType || 'user'];

  db.get(query, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (row) {
      try {
        res.json({ permissions: JSON.parse(row.permissions) });
      } catch (e) {
        res.json({ permissions: {} });
      }
    } else {
      res.json({ permissions: {} });
    }
  });
});

// Save/update access settings
app.post('/api/access-settings', (req, res) => {
  const { userId, roleType, roleId, permissions } = req.body;
  const createdBy = req.body.createdBy || null;

  if (!userId || !permissions) {
    return res.status(400).json({ error: 'User ID and permissions are required' });
  }

  const permissionsJson = JSON.stringify(permissions);

  db.run(`
    INSERT INTO access_settings (user_id, role_type, role_id, permissions, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, role_type, role_id) 
    DO UPDATE SET permissions = ?, updated_at = CURRENT_TIMESTAMP
  `, [
    userId, 
    roleType || 'user', 
    roleId || null, 
    permissionsJson, 
    createdBy,
    permissionsJson
  ], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

// Get all access settings (for admin view)
app.get('/api/access-settings/all', (req, res) => {
  db.all(`
    SELECT 
      a.*,
      v.full_name,
      v.avatar,
      v.position
    FROM access_settings a
    LEFT JOIN volunteers v ON a.user_id = v.id
    ORDER BY a.updated_at DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const result = rows.map(row => ({
      ...row,
      permissions: JSON.parse(row.permissions || '{}')
    }));
    
    res.json(result);
  });
});

// Check if user has a specific permission
app.get('/api/access-settings/check', (req, res) => {
  const { userId, permission, roleType, roleId } = req.query;

  if (!userId || !permission) {
    return res.status(400).json({ error: 'User ID and permission are required' });
  }

  // First check user-specific permissions, then role-specific
  db.all(`
    SELECT permissions FROM access_settings 
    WHERE user_id = ?
    ORDER BY 
      CASE WHEN role_type = 'user' THEN 0 ELSE 1 END,
      updated_at DESC
  `, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let hasPermission = false;

    for (const row of rows) {
      try {
        const perms = JSON.parse(row.permissions);
        if (perms[permission] === true) {
          hasPermission = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    res.json({ hasPermission });
  });
});

// Get all permissions for a user (combined from all their roles)
app.get('/api/access-settings/user/:userId', (req, res) => {
  const { userId } = req.params;

  db.all(`
    SELECT permissions, role_type, role_id FROM access_settings 
    WHERE user_id = ?
  `, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Combine all permissions (any true value wins)
    const combinedPermissions = {};

    for (const row of rows) {
      try {
        const perms = JSON.parse(row.permissions);
        Object.keys(perms).forEach(key => {
          if (perms[key] === true) {
            combinedPermissions[key] = true;
          }
        });
      } catch (e) {
        continue;
      }
    }

    res.json({ permissions: combinedPermissions });
  });
});

// Delete access settings for a user/role
app.delete('/api/access-settings', (req, res) => {
  const { userId, roleType, roleId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  db.run(`
    DELETE FROM access_settings 
    WHERE user_id = ? AND role_type = ? AND (role_id = ? OR (role_id IS NULL AND ? IS NULL))
  `, [userId, roleType || 'user', roleId || null, roleId || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// ==================== BUTTON ACCESS API ====================

// Get all button access (returns object with buttonId as key and array of userIds as value)
app.get('/api/button-access', (req, res) => {
  db.all(`SELECT button_id, user_id FROM button_access`, (err, rows) => {
    if (err) {
      console.error('Error fetching button access:', err);
      return res.status(500).json({ error: err.message });
    }
    
    // Transform into { buttonId: [userId1, userId2, ...], ... }
    const result = {};
    rows.forEach(row => {
      if (!result[row.button_id]) {
        result[row.button_id] = [];
      }
      result[row.button_id].push(row.user_id);
    });
    
    res.json(result);
  });
});

// Save button access for a specific button
app.post('/api/button-access', (req, res) => {
  const { buttonId, userIds, updatedBy } = req.body;
  
  if (!buttonId) {
    return res.status(400).json({ error: 'buttonId is required' });
  }
  
  // First delete all existing access for this button
  db.run(`DELETE FROM button_access WHERE button_id = ?`, [buttonId], function(err) {
    if (err) {
      console.error('Error deleting button access:', err);
      return res.status(500).json({ error: err.message });
    }
    
    if (!userIds || userIds.length === 0) {
      // Log the action
      db.run(`
        INSERT INTO access_logs (action_type, action_description, actor_id, target_type, details)
        VALUES (?, ?, ?, ?, ?)
      `, ['access_changed', `Removed all access for ${buttonId} button`, updatedBy, 'button', JSON.stringify({ buttonId, userIds: [] })]);
      
      return res.json({ success: true, message: 'All access removed for button' });
    }
    
    // Insert new access entries
    const stmt = db.prepare(`INSERT INTO button_access (button_id, user_id, updated_by) VALUES (?, ?, ?)`);
    
    userIds.forEach(userId => {
      stmt.run(buttonId, userId, updatedBy);
    });
    
    stmt.finalize((err) => {
      if (err) {
        console.error('Error saving button access:', err);
        return res.status(500).json({ error: err.message });
      }
      
      // Log the action
      db.run(`
        INSERT INTO access_logs (action_type, action_description, actor_id, target_type, details)
        VALUES (?, ?, ?, ?, ?)
      `, ['access_changed', `Updated access for ${buttonId} button`, updatedBy, 'button', JSON.stringify({ buttonId, userIds })]);
      
      res.json({ success: true, message: 'Button access saved successfully' });
    });
  });
});

// Check if user has access to a specific button
app.get('/api/button-access/check', (req, res) => {
  const { buttonId, userId } = req.query;
  
  if (!buttonId || !userId) {
    return res.status(400).json({ error: 'buttonId and userId are required' });
  }
  
  db.get(`SELECT id FROM button_access WHERE button_id = ? AND user_id = ?`, [buttonId, userId], (err, row) => {
    if (err) {
      console.error('Error checking button access:', err);
      return res.status(500).json({ error: err.message });
    }
    
    res.json({ hasAccess: !!row });
  });
});

// Get all buttons a user has access to
app.get('/api/button-access/user/:userId', (req, res) => {
  const { userId } = req.params;
  
  db.all(`SELECT button_id FROM button_access WHERE user_id = ?`, [userId], (err, rows) => {
    if (err) {
      console.error('Error fetching user button access:', err);
      return res.status(500).json({ error: err.message });
    }
    
    const buttons = rows.map(row => row.button_id);
    res.json({ buttons });
  });
});

// ==================== ACCESS LOGS API ====================

// Get all access logs
app.get('/api/access-logs', (req, res) => {
  const { actionType, limit } = req.query;
  
  let query = `
    SELECT 
      al.*,
      v.full_name as actor_name,
      v.avatar as actor_avatar
    FROM access_logs al
    LEFT JOIN volunteers v ON al.actor_id = v.id
  `;
  const params = [];
  
  if (actionType && actionType !== 'all') {
    query += ` WHERE al.action_type = ?`;
    params.push(actionType);
  }
  
  query += ` ORDER BY al.created_at DESC`;
  
  if (limit) {
    query += ` LIMIT ?`;
    params.push(parseInt(limit));
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error fetching access logs:', err);
      return res.status(500).json({ error: err.message });
    }
    
    res.json(rows);
  });
});

// Add a new log entry
app.post('/api/access-logs', (req, res) => {
  const { actionType, actionDescription, actorId, targetId, targetType, details } = req.body;
  
  if (!actionType || !actorId) {
    return res.status(400).json({ error: 'actionType and actorId are required' });
  }
  
  db.run(`
    INSERT INTO access_logs (action_type, action_description, actor_id, target_id, target_type, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [actionType, actionDescription, actorId, targetId, targetType, details ? JSON.stringify(details) : null], function(err) {
    if (err) {
      console.error('Error creating log entry:', err);
      return res.status(500).json({ error: err.message });
    }
    
    res.json({ id: this.lastID, message: 'Log entry created successfully' });
  });
});

// ==================== END ACCESS SETTINGS API ====================

// ==================== COURSES API ====================

// Get all courses (with optional filters)
app.get('/api/courses', (req, res) => {
  const { status, instructorId, userId } = req.query
  
  let query = `
    SELECT 
      c.*,
      v.full_name as instructor_name, 
      v.avatar as instructor_avatar,
      v.wing as instructor_wing
  `
  const params = []

  if (userId) {
    query += `,
      CASE WHEN EXISTS (
        SELECT 1 FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.volunteer_id = ?
      ) THEN 1 ELSE 0 END AS is_enrolled,
      (
        SELECT progress FROM course_enrollments ce2 WHERE ce2.course_id = c.id AND ce2.volunteer_id = ? LIMIT 1
      ) AS user_progress,
      (
        SELECT has_passed FROM course_enrollments ce3 WHERE ce3.course_id = c.id AND ce3.volunteer_id = ? LIMIT 1
      ) AS has_passed,
      (
        SELECT is_completed FROM course_enrollments ce4 WHERE ce4.course_id = c.id AND ce4.volunteer_id = ? LIMIT 1
      ) AS is_completed
    `
    params.push(userId, userId, userId, userId)
  } else {
    query += ', 0 AS is_enrolled, 0 AS user_progress, 0 AS has_passed, 0 AS is_completed'
  }

  query += `
    FROM courses c
    LEFT JOIN volunteers v ON c.instructor_id = v.id
  `
  
  let whereClause = ''
  
  if (status) {
    if (status === 'approved') {
      whereClause = ` WHERE c.approval_status = 'approved'`
    } else if (status === 'pending') {
      whereClause = ` WHERE c.approval_status = 'pending'`
    } else if (status === 'declined') {
      whereClause = ` WHERE c.approval_status = 'declined'`
    }
  }
  
  if (instructorId) {
    whereClause += whereClause ? ` AND c.instructor_id = ?` : ` WHERE c.instructor_id = ?`
    params.push(instructorId)
  }
  
  query += whereClause
  query += ' ORDER BY c.created_at DESC'
  
  db.all(query, params, async (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    
    // Fetch enrolled users for each course
    const coursesWithEnrolled = await Promise.all((rows || []).map(course => {
      return new Promise((resolve) => {
        db.all(`
          SELECT v.id, v.avatar, v.full_name 
          FROM course_enrollments ce 
          JOIN volunteers v ON ce.volunteer_id = v.id 
          WHERE ce.course_id = ? 
          LIMIT 5
        `, [course.id], (enrolledErr, enrolled) => {
          course.enrolled_users = enrolled || []
          resolve(course)
        })
      })
    }))
    
    res.json(coursesWithEnrolled)
  })
})

// Get pending course requests - MUST be before /api/courses/:id to avoid route conflict
app.get('/api/courses/requests/pending', (req, res) => {
  db.all(`
    SELECT 
      c.*,
      v.full_name as instructor_name, 
      v.avatar as instructor_avatar,
      v.wing as instructor_wing
    FROM courses c
    LEFT JOIN volunteers v ON c.instructor_id = v.id
    WHERE c.approval_status = 'pending'
    ORDER BY c.created_at DESC
  `, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(rows || [])
  })
})

// Get single course
app.get('/api/courses/:id', (req, res) => {
  const { id } = req.params
  const { userId } = req.query
  
  let query = `
    SELECT 
      c.*,
      v.full_name as instructor_name, 
      v.avatar as instructor_avatar,
      v.wing as instructor_wing,
      v.bio as instructor_bio,
      v.position as instructor_position
  `
  const params = []

  if (userId) {
    query += `,
      CASE WHEN EXISTS (
        SELECT 1 FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.volunteer_id = ?
      ) THEN 1 ELSE 0 END AS is_enrolled,
      (
        SELECT progress FROM course_enrollments ce2 WHERE ce2.course_id = c.id AND ce2.volunteer_id = ? LIMIT 1
      ) AS user_progress,
      (
        SELECT completed_lessons FROM course_enrollments ce3 WHERE ce3.course_id = c.id AND ce3.volunteer_id = ? LIMIT 1
      ) AS completed_lessons,
      (
        SELECT has_passed FROM course_enrollments ce4 WHERE ce4.course_id = c.id AND ce4.volunteer_id = ? LIMIT 1
      ) AS has_passed,
      (
        SELECT quiz_score FROM course_enrollments ce5 WHERE ce5.course_id = c.id AND ce5.volunteer_id = ? LIMIT 1
      ) AS quiz_score,
      (
        SELECT slide_position FROM course_enrollments ce6 WHERE ce6.course_id = c.id AND ce6.volunteer_id = ? LIMIT 1
      ) AS slide_position,
      (
        SELECT certificate_code FROM course_enrollments ce7 WHERE ce7.course_id = c.id AND ce7.volunteer_id = ? LIMIT 1
      ) AS certificate_code,
      (
        SELECT is_completed FROM course_enrollments ce8 WHERE ce8.course_id = c.id AND ce8.volunteer_id = ? LIMIT 1
      ) AS is_completed
    `
    params.push(userId, userId, userId, userId, userId, userId, userId, userId)
  } else {
    query += ', 0 AS is_enrolled, 0 AS user_progress, NULL AS completed_lessons, 0 AS has_passed, NULL AS quiz_score, 1 AS slide_position, NULL AS certificate_code, 0 AS is_completed'
  }

  query += `
    FROM courses c
    LEFT JOIN volunteers v ON c.instructor_id = v.id
    WHERE c.id = ?
  `
  params.push(id)
  
  db.get(query, params, (err, course) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!course) {
      res.status(404).json({ error: 'Course not found' })
      return
    }
    
    // Get lessons
    db.all('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY sort_order', [id], (lessonsErr, lessons) => {
      if (lessonsErr) {
        res.status(500).json({ error: lessonsErr.message })
        return
      }
      
      // Get enrolled users (sample avatars)
      db.all(`
        SELECT v.id, v.avatar, v.full_name 
        FROM course_enrollments ce 
        JOIN volunteers v ON ce.volunteer_id = v.id 
        WHERE ce.course_id = ? 
        LIMIT 5
      `, [id], (enrolledErr, enrolled) => {
        course.lessons = lessons || []
        course.enrolled_users = enrolled || []
        res.json(course)
      })
    })
  })
})

// Create course (instructor creates request)
app.post('/api/courses', (req, res) => {
  const { 
    title, 
    description, 
    category, 
    badge,
    image, 
    slideFile,
    slideFileName,
    durationHours,
    lessonsCount,
    instructorId,
    certificateDesign,
    quizQuestions,
    lessons 
  } = req.body

  if (!title || !instructorId) {
    return res.status(400).json({ error: 'Title and instructor ID are required' })
  }

  db.run(`
    INSERT INTO courses (
      title, description, category, badge, image, slide_file, slide_file_name,
      duration_hours, lessons_count, instructor_id, certificate_design, quiz_questions, approval_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [
    title, 
    description || '', 
    category || 'General', 
    badge || 'Course',
    image || '',
    slideFile || '',
    slideFileName || '',
    durationHours || 1.0,
    lessonsCount || (lessons ? lessons.length : 1),
    instructorId,
    certificateDesign || 1,
    quizQuestions || null
  ], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    
    const courseId = this.lastID
    
    // Insert lessons if provided
    if (lessons && lessons.length > 0) {
      const lessonStmt = db.prepare(`
        INSERT INTO course_lessons (course_id, title, content, duration_minutes, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `)
      
      lessons.forEach((lesson, index) => {
        lessonStmt.run(courseId, lesson.title, lesson.content || '', lesson.duration || 10, index)
      })
      
      lessonStmt.finalize()
    }
    
    res.json({ 
      success: true, 
      id: courseId,
      message: 'Course submitted for approval'
    })
  })
})

// Update course
app.put('/api/courses/:id', (req, res) => {
  const { id } = req.params
  const { 
    title, 
    description, 
    category, 
    badge,
    image, 
    slideFile,
    slideFileName,
    durationHours,
    lessonsCount,
    certificateDesign
  } = req.body

  db.run(`
    UPDATE courses SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      category = COALESCE(?, category),
      badge = COALESCE(?, badge),
      image = COALESCE(?, image),
      slide_file = COALESCE(?, slide_file),
      slide_file_name = COALESCE(?, slide_file_name),
      duration_hours = COALESCE(?, duration_hours),
      lessons_count = COALESCE(?, lessons_count),
      certificate_design = COALESCE(?, certificate_design),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [title, description, category, badge, image, slideFile, slideFileName, durationHours, lessonsCount, certificateDesign, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true })
  })
})

// Approve course
app.put('/api/courses/:id/approve', (req, res) => {
  const { id } = req.params
  const { reviewedBy } = req.body

  db.run(`
    UPDATE courses SET
      approval_status = 'approved',
      reviewed_by = ?,
      reviewed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reviewedBy, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true, message: 'Course approved' })
  })
})

// Decline course
app.put('/api/courses/:id/decline', (req, res) => {
  const { id } = req.params
  const { reviewedBy, reason } = req.body

  db.run(`
    UPDATE courses SET
      approval_status = 'declined',
      decline_reason = ?,
      reviewed_by = ?,
      reviewed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reason || 'Not approved', reviewedBy, id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true, message: 'Course declined' })
  })
})

// Enroll in course
app.post('/api/courses/:id/enroll', (req, res) => {
  const { id } = req.params
  const { volunteerId } = req.body

  if (!volunteerId) {
    return res.status(400).json({ error: 'Volunteer ID is required' })
  }

  // Check if already enrolled
  db.get('SELECT 1 FROM course_enrollments WHERE course_id = ? AND volunteer_id = ?', [id, volunteerId], (checkErr, existing) => {
    if (checkErr) {
      res.status(500).json({ error: checkErr.message })
      return
    }
    
    if (existing) {
      return res.json({ success: true, alreadyEnrolled: true })
    }

    db.run(`
      INSERT INTO course_enrollments (course_id, volunteer_id)
      VALUES (?, ?)
    `, [id, volunteerId], function(err) {
      if (err) {
        res.status(500).json({ error: err.message })
        return
      }
      
      // Update enrolled count
      db.run('UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = ?', [id])
      
      // Notify course instructor about new enrollment
      db.get(`
        SELECT c.title, c.instructor_id, v.full_name, v.avatar
        FROM courses c
        JOIN volunteers v ON v.id = ?
        WHERE c.id = ?
      `, [volunteerId, id], (courseErr, courseData) => {
        if (!courseErr && courseData && courseData.instructor_id && courseData.instructor_id != volunteerId) {
          createNotification(courseData.instructor_id, 'course_enrollment',
            `enrolled in your course "${courseData.title}"`, {
              data: { courseId: parseInt(id) },
              actorId: parseInt(volunteerId),
              actorName: courseData.full_name,
              actorAvatar: courseData.avatar,
              priority: 'low'
          }).catch(console.error);
        }
      });
      
      res.json({ success: true })
    })
  })
})

// Course Q&A endpoints
app.get('/api/courses/:id/questions', (req, res) => {
  const { id } = req.params
  
  db.all(`
    SELECT 
      q.*,
      v.full_name as asker_name,
      v.avatar as asker_avatar,
      a.full_name as answerer_name,
      a.avatar as answerer_avatar
    FROM course_questions q
    LEFT JOIN volunteers v ON q.volunteer_id = v.id
    LEFT JOIN volunteers a ON q.answered_by = a.id
    WHERE q.course_id = ?
    ORDER BY q.created_at DESC
  `, [id], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(rows || [])
  })
})

app.post('/api/courses/:id/questions', (req, res) => {
  const { id } = req.params
  const { volunteerId, question } = req.body

  if (!volunteerId || !question) {
    return res.status(400).json({ error: 'Volunteer ID and question are required' })
  }

  db.run(`
    INSERT INTO course_questions (course_id, volunteer_id, question)
    VALUES (?, ?, ?)
  `, [id, volunteerId, question], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true, id: this.lastID })
  })
})

// Get course ratings
app.get('/api/courses/:id/ratings', (req, res) => {
  const { id } = req.params
  const { userId } = req.query

  // Get all ratings with volunteer info
  db.all(`
    SELECT 
      cr.*,
      v.full_name,
      v.avatar,
      v.wing
    FROM course_ratings cr
    LEFT JOIN volunteers v ON cr.volunteer_id = v.id
    WHERE cr.course_id = ?
    ORDER BY cr.created_at DESC
  `, [id], (err, ratings) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }

    // Calculate average rating
    const totalRatings = ratings.length
    const avgRating = totalRatings > 0 
      ? (ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings).toFixed(1)
      : 0

    // Get user's rating if userId provided
    let userRating = null
    if (userId) {
      userRating = ratings.find(r => r.volunteer_id === parseInt(userId)) || null
    }

    res.json({
      ratings,
      totalRatings,
      avgRating: parseFloat(avgRating),
      userRating
    })
  })
})

// Submit course rating
app.post('/api/courses/:id/ratings', (req, res) => {
  const { id } = req.params
  const { volunteerId, rating, review } = req.body

  if (!volunteerId || !rating) {
    return res.status(400).json({ error: 'Volunteer ID and rating are required' })
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' })
  }

  // Use INSERT OR REPLACE to handle both new ratings and updates
  db.run(`
    INSERT OR REPLACE INTO course_ratings (course_id, volunteer_id, rating, review, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [id, volunteerId, rating, review || ''], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }

    // Update course average rating
    db.get(`
      SELECT AVG(rating) as avg_rating, COUNT(*) as total_ratings
      FROM course_ratings
      WHERE course_id = ?
    `, [id], (avgErr, avgResult) => {
      if (!avgErr && avgResult) {
        db.run(`
          UPDATE courses SET 
            rating = ?,
            enrolled = ?
          WHERE id = ?
        `, [avgResult.avg_rating.toFixed(1), avgResult.total_ratings, id])
      }
    })

    res.json({ success: true, id: this.lastID })
  })
})

app.put('/api/courses/questions/:questionId/answer', (req, res) => {
  const { questionId } = req.params
  const { answeredBy, answer } = req.body

  db.run(`
    UPDATE course_questions SET
      answer = ?,
      answered_by = ?,
      answered_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [answer, answeredBy, questionId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true })
  })
})

// Update course progress
app.put('/api/courses/:id/progress', (req, res) => {
  const { id } = req.params
  const { volunteerId, progress, completedLessons } = req.body

  if (!volunteerId) {
    return res.status(400).json({ error: 'Volunteer ID is required' })
  }

  db.run(`
    UPDATE course_enrollments SET
      progress = ?,
      completed_lessons = ?,
      updated_at = CURRENT_TIMESTAMP,
      completed = CASE WHEN ? >= 100 THEN 1 ELSE 0 END
    WHERE course_id = ? AND volunteer_id = ?
  `, [progress, completedLessons, progress, id, volunteerId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true })
  })
})

// Save certificate/pass status
app.post('/api/courses/:id/certificate', (req, res) => {
  const { id } = req.params
  const { volunteerId, score, certificateCode } = req.body

  if (!volunteerId) {
    return res.status(400).json({ error: 'Volunteer ID is required' })
  }

  db.run(`
    UPDATE course_enrollments SET
      has_passed = 1,
      quiz_score = ?,
      certificate_code = ?,
      certificate_issued_at = CURRENT_TIMESTAMP
    WHERE course_id = ? AND volunteer_id = ?
  `, [score, certificateCode, id, volunteerId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    
    // Award points to volunteer for completing the course
    db.run('UPDATE volunteers SET points = points + 50, respect_points = respect_points + 25 WHERE id = ?', [volunteerId])
    
    // Notify the volunteer about course completion and certificate
    db.get('SELECT title FROM courses WHERE id = ?', [id], (courseErr, course) => {
      if (!courseErr && course) {
        createNotification(volunteerId, 'course_completed',
          `Congratulations! You've completed "${course.title}" with a score of ${score}%! 🎓`, {
            data: { courseId: parseInt(id), score, certificateCode },
            priority: 'high'
        }).catch(console.error);
      }
    });
    
    res.json({ success: true, certificateCode })
  })
})

// Save slide progress
app.put('/api/courses/:id/slide-progress', (req, res) => {
  const { id } = req.params
  const { volunteerId, currentSlide, totalSlides, isCompleted } = req.body

  if (!volunteerId) {
    return res.status(400).json({ error: 'Volunteer ID is required' })
  }

  const progress = Math.round((currentSlide / totalSlides) * 100)

  db.run(`
    UPDATE course_enrollments SET
      slide_position = ?,
      progress = ?,
      is_completed = ?
    WHERE course_id = ? AND volunteer_id = ?
  `, [currentSlide, progress, isCompleted ? 1 : 0, id, volunteerId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true, progress, currentSlide })
  })
})

// Get enrollment details with slide position
app.get('/api/courses/:id/enrollment/:volunteerId', (req, res) => {
  const { id, volunteerId } = req.params

  db.get(`
    SELECT *, slide_position as currentSlide 
    FROM course_enrollments 
    WHERE course_id = ? AND volunteer_id = ?
  `, [id, volunteerId], (err, enrollment) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json(enrollment || { enrolled: false })
  })
})

// Validate certificate by code
app.get('/api/certificates/validate/:code', (req, res) => {
  const { code } = req.params

  db.get(`
    SELECT 
      ce.*,
      c.title as course_title,
      c.description as course_description,
      c.image as course_image,
      v.name as volunteer_name,
      v.avatar as volunteer_avatar
    FROM course_enrollments ce
    JOIN courses c ON ce.course_id = c.id
    JOIN volunteers v ON ce.volunteer_id = v.id
    WHERE ce.certificate_code = ? AND ce.has_passed = 1
  `, [code], (err, result) => {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    if (!result) {
      res.status(404).json({ error: 'Certificate not found or invalid' })
      return
    }
    res.json({
      valid: true,
      certificate: {
        code: result.certificate_code,
        volunteerName: result.volunteer_name,
        volunteerAvatar: result.volunteer_avatar,
        courseTitle: result.course_title,
        courseDescription: result.course_description,
        courseImage: result.course_image,
        quizScore: result.quiz_score,
        issuedAt: result.certificate_issued_at,
        enrolledAt: result.enrolled_at
      }
    })
  })
})

// Save certificate code when certificate is issued
app.put('/api/courses/:id/certificate-code', (req, res) => {
  const { id } = req.params
  const { volunteerId, certificateCode } = req.body

  if (!volunteerId || !certificateCode) {
    return res.status(400).json({ error: 'Volunteer ID and certificate code are required' })
  }

  db.run(`
    UPDATE course_enrollments SET
      certificate_code = ?
    WHERE course_id = ? AND volunteer_id = ?
  `, [certificateCode, id, volunteerId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message })
      return
    }
    res.json({ success: true })
  })
})

// AI Quiz Generation endpoint
app.post('/api/ai/generate-quiz', async (req, res) => {
  const { topic, count, courseTitle, courseDescription } = req.body
  
  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' })
  }
  
  const questionCount = Math.min(Math.max(count || 5, 1), 15)
  
  // Generate questions based on the topic
  // This is a smart fallback that generates contextual questions
  const questions = generateSmartQuestions(topic, questionCount, courseTitle, courseDescription)
  
  res.json({ questions, source: 'generated' })
})

// Smart question generator function
function generateSmartQuestions(topic, count, courseTitle, courseDescription) {
  const topicLower = topic.toLowerCase()
  const questions = []
  
  // Common question patterns based on topic keywords
  const patterns = [
    {
      keywords: ['first aid', 'emergency', 'medical', 'cpr', 'health'],
      questions: [
        { q: 'What is the first step in any emergency response?', opts: ['Call for help immediately', 'Assess scene safety first', 'Start treatment right away', 'Look for the cause'], correct: 1 },
        { q: 'What does CPR stand for?', opts: ['Cardiac Pulse Recovery', 'Cardiopulmonary Resuscitation', 'Chest Pain Relief', 'Critical Patient Response'], correct: 1 },
        { q: 'When should you use an AED (Automated External Defibrillator)?', opts: ['For broken bones', 'For cardiac arrest', 'For burns', 'For choking'], correct: 1 },
        { q: 'What is the correct compression rate for adult CPR?', opts: ['60-80 per minute', '80-100 per minute', '100-120 per minute', '120-140 per minute'], correct: 2 },
        { q: 'How do you control severe bleeding?', opts: ['Apply ice to the wound', 'Apply direct pressure', 'Elevate only', 'Use a tourniquet first'], correct: 1 },
        { q: 'What should you do if someone is choking?', opts: ['Give them water', 'Perform back blows and abdominal thrusts', 'Make them lie down', 'Wait for help'], correct: 1 },
        { q: 'What is the recovery position used for?', opts: ['Broken bones', 'Unconscious breathing patients', 'Heart attacks', 'Burns'], correct: 1 },
      ]
    },
    {
      keywords: ['leadership', 'management', 'team', 'leader'],
      questions: [
        { q: 'What is the most important quality of a good leader?', opts: ['Being strict', 'Having authority', 'Effective communication', 'Technical skills only'], correct: 2 },
        { q: 'How should a leader handle team conflicts?', opts: ['Ignore them', 'Address them promptly and fairly', 'Take sides', 'Let team resolve it'], correct: 1 },
        { q: 'What is emotional intelligence in leadership?', opts: ['Being emotional', 'Understanding and managing emotions', 'Hiding emotions', 'Ignoring feelings'], correct: 1 },
        { q: 'What is the best way to motivate a team?', opts: ['Punishment for failures', 'Recognition and support', 'Strict deadlines', 'Competition only'], correct: 1 },
        { q: 'How should leaders make decisions?', opts: ['Alone without input', 'Based on data and team input', 'By voting only', 'Randomly'], correct: 1 },
      ]
    },
    {
      keywords: ['volunteer', 'community', 'service', 'social'],
      questions: [
        { q: 'What is the primary goal of volunteering?', opts: ['Personal gain', 'Helping others and community', 'Building resume', 'Meeting people only'], correct: 1 },
        { q: 'How should volunteers handle confidential information?', opts: ['Share freely', 'Keep it strictly confidential', 'Post on social media', 'Tell friends'], correct: 1 },
        { q: 'What makes community service effective?', opts: ['Working alone', 'Collaboration and consistency', 'One-time efforts', 'Large donations only'], correct: 1 },
        { q: 'Why is reliability important for volunteers?', opts: ['It is not important', 'People depend on your commitment', 'To impress others', 'For personal benefit'], correct: 1 },
      ]
    },
    {
      keywords: ['disaster', 'earthquake', 'flood', 'cyclone', 'fire', 'safety'],
      questions: [
        { q: 'What should you do during an earthquake?', opts: ['Run outside immediately', 'Drop, Cover, and Hold On', 'Stand near windows', 'Use the elevator'], correct: 1 },
        { q: 'What is the best action during a flood warning?', opts: ['Stay in low areas', 'Move to higher ground', 'Drive through water', 'Ignore warnings'], correct: 1 },
        { q: 'What should you do if there is a fire?', opts: ['Hide under bed', 'Open windows for air', 'Stay low and exit safely', 'Use elevator'], correct: 2 },
        { q: 'What is an emergency kit?', opts: ['Medical bag only', 'Supplies for survival during emergencies', 'First aid kit only', 'Food storage'], correct: 1 },
        { q: 'Why are emergency drills important?', opts: ['They are not important', 'To practice response procedures', 'For entertainment', 'To scare people'], correct: 1 },
      ]
    }
  ]
  
  // Find matching pattern
  let matchedQuestions = []
  for (const pattern of patterns) {
    if (pattern.keywords.some(kw => topicLower.includes(kw))) {
      matchedQuestions = [...matchedQuestions, ...pattern.questions]
    }
  }
  
  // If no specific match, use generic questions
  if (matchedQuestions.length === 0) {
    matchedQuestions = [
      { q: `What is the primary purpose of ${topic}?`, opts: ['To help people', 'To save resources', 'To improve efficiency', 'All of the above'], correct: 3 },
      { q: `Which approach best describes ${topic}?`, opts: ['Theoretical only', 'Practical only', 'A combination of theory and practice', 'None of these'], correct: 2 },
      { q: `When is the best time to apply ${topic}?`, opts: ['Only in emergencies', 'During planning phases', 'In all relevant situations', 'Never'], correct: 2 },
      { q: `What is a key benefit of understanding ${topic}?`, opts: ['Better decision making', 'Improved outcomes', 'Increased confidence', 'All of the above'], correct: 3 },
      { q: `Who should learn about ${topic}?`, opts: ['Only experts', 'Only beginners', 'Anyone interested in the field', 'No one'], correct: 2 },
      { q: `How does knowledge of ${topic} contribute to success?`, opts: ['By providing structure', 'By offering guidance', 'By enabling informed decisions', 'All of the above'], correct: 3 },
      { q: `What is essential when practicing ${topic}?`, opts: ['Patience and consistency', 'Speed only', 'Luck', 'None of these'], correct: 0 },
    ]
  }
  
  // Shuffle and select required count
  const shuffled = matchedQuestions.sort(() => Math.random() - 0.5)
  
  for (let i = 0; i < Math.min(count, shuffled.length); i++) {
    questions.push({
      question: shuffled[i].q,
      options: shuffled[i].opts,
      correct: shuffled[i].correct
    })
  }
  
  return questions
}

// ==================== END COURSES API ====================

// ==================== BADGES API ====================

// Get all badges
app.get('/api/badges', (req, res) => {
  db.all('SELECT * FROM badges ORDER BY created_at DESC', [], (err, badges) => {
    if (err) {
      console.error('Error fetching badges:', err)
      return res.status(500).json({ error: 'Failed to fetch badges' })
    }
    res.json(badges || [])
  })
})

// Search volunteers for badge assignment - MUST be before :id route
app.get('/api/badges/search-volunteers', (req, res) => {
  const { q } = req.query
  
  if (!q || q.length < 2) {
    return res.json([])
  }
  
  db.all(
    `SELECT id, full_name, avatar, position, email 
     FROM volunteers 
     WHERE full_name LIKE ? OR email LIKE ?
     LIMIT 15`,
    [`%${q}%`, `%${q}%`],
    (err, volunteers) => {
      if (err) {
        console.error('Error searching volunteers:', err)
        return res.status(500).json({ error: 'Search failed' })
      }
      res.json(volunteers || [])
    }
  )
})

// Get single badge
app.get('/api/badges/:id', (req, res) => {
  db.get('SELECT * FROM badges WHERE id = ?', [req.params.id], (err, badge) => {
    if (err) {
      console.error('Error fetching badge:', err)
      return res.status(500).json({ error: 'Failed to fetch badge' })
    }
    if (!badge) {
      return res.status(404).json({ error: 'Badge not found' })
    }
    res.json(badge)
  })
})

// Create badge
app.post('/api/badges', (req, res) => {
  const { name, description, icon_url, color, criteria } = req.body
  
  if (!name) {
    return res.status(400).json({ error: 'Badge name is required' })
  }
  
  db.run(
    'INSERT INTO badges (name, description, icon_url, color, criteria) VALUES (?, ?, ?, ?, ?)',
    [name, description || '', icon_url || 'military_tech', color || '#3b82f6', criteria || ''],
    function(err) {
      if (err) {
        console.error('Error creating badge:', err)
        return res.status(500).json({ error: 'Failed to create badge' })
      }
      res.json({ id: this.lastID, message: 'Badge created successfully' })
    }
  )
})

// Update badge
app.put('/api/badges/:id', (req, res) => {
  const { name, description, icon_url, color, criteria } = req.body
  
  db.run(
    'UPDATE badges SET name = ?, description = ?, icon_url = ?, color = ?, criteria = ? WHERE id = ?',
    [name, description, icon_url, color, criteria, req.params.id],
    function(err) {
      if (err) {
        console.error('Error updating badge:', err)
        return res.status(500).json({ error: 'Failed to update badge' })
      }
      res.json({ message: 'Badge updated successfully' })
    }
  )
})

// Delete badge
app.delete('/api/badges/:id', (req, res) => {
  db.run('DELETE FROM badges WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      console.error('Error deleting badge:', err)
      return res.status(500).json({ error: 'Failed to delete badge' })
    }
    // Also delete related volunteer badges
    db.run('DELETE FROM volunteer_badges WHERE badge_id = ?', [req.params.id])
    res.json({ message: 'Badge deleted successfully' })
  })
})

// Award badge to multiple volunteers
app.post('/api/badges/:badgeId/award', async (req, res) => {
  const { volunteer_ids, awarded_by, note } = req.body
  const { badgeId } = req.params
  
  // Support both single volunteer_id and array of volunteer_ids
  const ids = volunteer_ids || (req.body.volunteer_id ? [req.body.volunteer_id] : [])
  
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: 'Volunteer ID(s) required' })
  }
  
  // Get badge name for activity
  db.get('SELECT name FROM badges WHERE id = ?', [badgeId], (err, badge) => {
    if (err || !badge) {
      return res.status(404).json({ error: 'Badge not found' })
    }
    
    const badgeName = badge.name
    let awarded = 0
    let skipped = 0
    
    const processVolunteer = (volunteerId, callback) => {
      // Check if already awarded
      db.get(
        'SELECT * FROM volunteer_badges WHERE volunteer_id = ? AND badge_id = ?',
        [volunteerId, badgeId],
        (err, existing) => {
          if (existing) {
            skipped++
            return callback()
          }
          
          db.run(
            'INSERT INTO volunteer_badges (volunteer_id, badge_id, awarded_by, note) VALUES (?, ?, ?, ?)',
            [volunteerId, badgeId, awarded_by || null, note || ''],
            function(err) {
              if (err) {
                console.error('Error awarding badge:', err)
                skipped++
                return callback()
              }
              
              awarded++
              
              // Notify user about badge earned
              createNotification(volunteerId, 'badge_earned',
                `Congratulations! You've earned the "${badgeName}" badge!`, {
                  data: { badgeId: parseInt(badgeId), badgeName },
                  priority: 'high'
              }).catch(console.error);
              
              // Add to activities
              db.run(
                `INSERT INTO activities (volunteer_id, activity_type, description, created_at) 
                 VALUES (?, 'badge_earned', ?, datetime('now'))`,
                [volunteerId, `Earned the "${badgeName}" badge with glory!`],
                (actErr) => {
                  if (actErr) console.error('Error adding badge activity:', actErr)
                  callback()
                }
              )
            }
          )
        }
      )
    }
    
    // Process all volunteers sequentially
    let index = 0
    const next = () => {
      if (index >= ids.length) {
        // Log the badge award action
        if (awarded > 0) {
          db.run(`
            INSERT INTO access_logs (action_type, action_description, actor_id, target_id, target_type, details)
            VALUES (?, ?, ?, ?, ?, ?)
          `, ['badge_awarded', `Awarded "${badgeName}" badge to ${awarded} volunteer(s)`, awarded_by || 0, badgeId, 'badge', 
              JSON.stringify({ badgeId, badgeName, volunteerIds: ids, awarded, skipped })]);
        }
        
        return res.json({ 
          message: `Badge awarded to ${awarded} volunteer(s)${skipped > 0 ? `, ${skipped} skipped (already had badge)` : ''}`,
          awarded,
          skipped
        })
      }
      processVolunteer(ids[index++], next)
    }
    next()
  })
})

// Remove badge from volunteer
app.delete('/api/badges/:badgeId/revoke/:volunteerId', (req, res) => {
  const { badgeId, volunteerId } = req.params
  
  db.run(
    'DELETE FROM volunteer_badges WHERE badge_id = ? AND volunteer_id = ?',
    [badgeId, volunteerId],
    function(err) {
      if (err) {
        console.error('Error revoking badge:', err)
        return res.status(500).json({ error: 'Failed to revoke badge' })
      }
      res.json({ message: 'Badge revoked successfully' })
    }
  )
})

// Get badges for a volunteer
app.get('/api/volunteers/:id/badges', (req, res) => {
  db.all(
    `SELECT b.*, vb.awarded_at, vb.note, vb.awarded_by,
     (SELECT full_name FROM volunteers WHERE id = vb.awarded_by) as awarded_by_name
     FROM volunteer_badges vb
     JOIN badges b ON vb.badge_id = b.id
     WHERE vb.volunteer_id = ?
     ORDER BY vb.awarded_at DESC`,
    [req.params.id],
    (err, badges) => {
      if (err) {
        console.error('Error fetching volunteer badges:', err)
        return res.status(500).json({ error: 'Failed to fetch badges' })
      }
      res.json(badges || [])
    }
  )
})

// Get volunteers who have a specific badge
app.get('/api/badges/:id/volunteers', (req, res) => {
  db.all(
    `SELECT v.id, v.full_name, v.avatar, v.position, vb.awarded_at, vb.note
     FROM volunteer_badges vb
     JOIN volunteers v ON vb.volunteer_id = v.id
     WHERE vb.badge_id = ?
     ORDER BY vb.awarded_at DESC`,
    [req.params.id],
    (err, volunteers) => {
      if (err) {
        console.error('Error fetching badge volunteers:', err)
        return res.status(500).json({ error: 'Failed to fetch volunteers' })
      }
      res.json(volunteers || [])
    }
  )
})

// AI Generate Badge
app.post('/api/ai/generate-badge', (req, res) => {
  const { theme, purpose, title } = req.body
  const badgeName = title || theme || ''
  
  // Icon mapping based on keywords
  const iconMapping = {
    'leader': { icon: 'military_tech', color: '#3b82f6' },
    'team': { icon: 'groups', color: '#10b981' },
    'star': { icon: 'star', color: '#fbbf24' },
    'innovate': { icon: 'lightbulb', color: '#8b5cf6' },
    'creative': { icon: 'lightbulb', color: '#ec4899' },
    'community': { icon: 'volunteer_activism', color: '#ef4444' },
    'service': { icon: 'favorite', color: '#ef4444' },
    'mentor': { icon: 'school', color: '#84cc16' },
    'teach': { icon: 'school', color: '#06b6d4' },
    'event': { icon: 'emoji_events', color: '#f97316' },
    'campaign': { icon: 'emoji_events', color: '#f59e0b' },
    'hero': { icon: 'shield', color: '#6366f1' },
    'champion': { icon: 'trophy', color: '#fbbf24' },
    'excellence': { icon: 'workspace_premium', color: '#fbbf24' },
    'dedicate': { icon: 'favorite', color: '#ef4444' },
    'reliable': { icon: 'verified', color: '#14b8a6' },
    'trust': { icon: 'verified', color: '#10b981' },
    'rising': { icon: 'trending_up', color: '#06b6d4' },
    'growth': { icon: 'trending_up', color: '#84cc16' },
    'first': { icon: 'looks_one', color: '#f59e0b' },
    'pioneer': { icon: 'rocket_launch', color: '#8b5cf6' },
    'help': { icon: 'volunteer_activism', color: '#10b981' },
    'support': { icon: 'handshake', color: '#3b82f6' },
    'friend': { icon: 'diversity_3', color: '#ec4899' },
    'ally': { icon: 'handshake', color: '#06b6d4' },
    'loyal': { icon: 'diamond', color: '#8b5cf6' },
    'premium': { icon: 'diamond', color: '#fbbf24' },
    'gold': { icon: 'workspace_premium', color: '#fbbf24' },
    'silver': { icon: 'workspace_premium', color: '#9ca3af' },
    'bronze': { icon: 'workspace_premium', color: '#f97316' },
    'fire': { icon: 'local_fire_department', color: '#ef4444' },
    'hot': { icon: 'local_fire_department', color: '#f97316' },
    'energy': { icon: 'bolt', color: '#fbbf24' },
    'power': { icon: 'bolt', color: '#8b5cf6' },
    'eco': { icon: 'eco', color: '#10b981' },
    'green': { icon: 'eco', color: '#84cc16' },
    'nature': { icon: 'park', color: '#10b981' },
    'king': { icon: 'crown', color: '#fbbf24' },
    'queen': { icon: 'crown', color: '#ec4899' },
    'royal': { icon: 'crown', color: '#8b5cf6' }
  }
  
  // Description templates based on keywords
  const descTemplates = {
    'leader': 'Recognizes exceptional leadership skills and the ability to guide and inspire others towards achieving common goals.',
    'team': 'Awarded for outstanding teamwork, collaboration, and the spirit of working together harmoniously.',
    'star': 'Celebrates stellar performance and being a shining example for others to follow.',
    'innovate': 'Honors creative thinking, innovative solutions, and forward-thinking approaches to challenges.',
    'creative': 'Recognizes artistic vision, creative problem-solving, and thinking outside the box.',
    'community': 'Awarded for dedicated service to the community and making a positive impact on society.',
    'service': 'Honors selfless dedication to serving others and contributing to meaningful causes.',
    'mentor': 'Recognizes the gift of guidance, knowledge sharing, and helping others grow and succeed.',
    'teach': 'Celebrates the passion for education and the commitment to empowering others with knowledge.',
    'event': 'Awarded for exceptional contribution to organizing and executing successful events.',
    'campaign': 'Honors outstanding performance and dedication during campaigns and special initiatives.',
    'hero': 'Recognizes acts of bravery, going above and beyond, and being a true hero to the community.',
    'champion': 'Celebrates achieving excellence and being a champion in your field of contribution.',
    'excellence': 'Awarded for demonstrating the highest standards of quality and exceptional performance.',
    'dedicate': 'Honors unwavering commitment, persistence, and dedication to the cause.',
    'reliable': 'Recognizes consistent dependability, trustworthiness, and being someone others can count on.',
    'trust': 'Awarded for building trust, maintaining integrity, and being a pillar of reliability.',
    'rising': 'Celebrates remarkable growth, improvement, and showing great potential for the future.',
    'growth': 'Honors continuous self-improvement and the journey of personal and professional development.',
    'first': 'Recognizes being first to achieve something significant or pioneering a new initiative.',
    'pioneer': 'Awarded for blazing new trails, exploring new frontiers, and leading the way.',
    'help': 'Honors the spirit of helping others and making a difference in people\'s lives.',
    'support': 'Recognizes providing crucial support and being a backbone for teams and individuals.',
    'friend': 'Celebrates building meaningful connections and fostering friendship within the community.',
    'ally': 'Awarded for standing together, supporting causes, and being a true ally.',
    'loyal': 'Honors steadfast loyalty, commitment, and being a dedicated member of the organization.',
    'premium': 'Recognizes achieving premium status through exceptional contributions and excellence.',
    'gold': 'Celebrates reaching the gold tier of achievement and outstanding performance.',
    'silver': 'Awarded for achieving silver level excellence and remarkable contributions.',
    'bronze': 'Honors reaching bronze level achievement and significant milestones.',
    'fire': 'Recognizes bringing energy, passion, and fire to everything you do.',
    'hot': 'Celebrates being on fire with achievements and trending upward consistently.',
    'energy': 'Awarded for bringing boundless energy and enthusiasm to every task.',
    'power': 'Honors demonstrating strength, influence, and powerful impact.',
    'eco': 'Recognizes commitment to environmental sustainability and eco-friendly practices.',
    'green': 'Celebrates environmental consciousness and green initiatives.',
    'nature': 'Awarded for connecting with and protecting our natural environment.',
    'king': 'Recognizes reigning supreme in your domain and achieving royal status.',
    'queen': 'Celebrates being a queen in your field of excellence.',
    'royal': 'Honors achieving royal status through exceptional achievements.'
  }
  
  // Criteria templates
  const criteriaTemplates = {
    'leader': 'Successfully lead at least 3 projects or teams to completion.',
    'team': 'Participate actively in 5+ collaborative team projects.',
    'star': 'Consistently exceed expectations and receive positive recognition.',
    'innovate': 'Propose and implement at least 2 innovative ideas or solutions.',
    'creative': 'Demonstrate creative thinking in solving organizational challenges.',
    'community': 'Complete 100+ hours of community service activities.',
    'service': 'Dedicate 50+ hours to service-oriented tasks.',
    'mentor': 'Successfully mentor and guide at least 3 new volunteers.',
    'teach': 'Conduct training sessions or educational activities for others.',
    'event': 'Actively contribute to organizing 3+ successful events.',
    'campaign': 'Participate in and contribute significantly to 5+ campaigns.',
    'hero': 'Demonstrate exceptional courage or go above and beyond expectations.',
    'champion': 'Achieve top performance in your area of contribution.',
    'excellence': 'Maintain consistently high standards across all activities.',
    'dedicate': 'Show consistent dedication over 6+ months of active participation.',
    'reliable': 'Maintain 95%+ attendance and complete all assigned tasks on time.',
    'trust': 'Build trust through consistent honest and ethical behavior.',
    'rising': 'Show significant improvement and growth over time.',
    'growth': 'Demonstrate measurable personal or professional development.',
    'first': 'Be the first to achieve a significant milestone or goal.',
    'pioneer': 'Lead the way in starting a new initiative or program.',
    'help': 'Provide meaningful help to at least 10 different people.',
    'support': 'Offer consistent support to team members and projects.',
    'friend': 'Build strong positive relationships with fellow volunteers.',
    'ally': 'Actively support and advocate for organizational causes.',
    'loyal': 'Maintain active membership for 12+ months.',
    'premium': 'Achieve exceptional status through outstanding contributions.',
    'gold': 'Reach the highest tier of contribution points.',
    'silver': 'Accumulate silver-level contribution points.',
    'bronze': 'Achieve bronze-level milestones and contributions.',
    'fire': 'Bring high energy and passion consistently to activities.',
    'hot': 'Be trending in the top 10% of active contributors.',
    'energy': 'Demonstrate consistent enthusiasm and energy.',
    'power': 'Make a powerful impact on organizational goals.',
    'eco': 'Lead or participate in 3+ environmental initiatives.',
    'green': 'Promote and practice sustainable activities.',
    'nature': 'Contribute to nature conservation efforts.',
    'king': 'Achieve top ranking in your category.',
    'queen': 'Excel and reign in your area of expertise.',
    'royal': 'Achieve prestigious recognition for contributions.'
  }
  
  // Find matching keywords
  const nameLower = badgeName.toLowerCase()
  let selectedIcon = 'military_tech'
  let selectedColor = '#3b82f6'
  let description = `This badge recognizes outstanding achievement in ${badgeName.toLowerCase()}.`
  let criteria = `Demonstrate excellence and meet the requirements for ${badgeName}.`
  
  // Check for keyword matches
  for (const [keyword, mapping] of Object.entries(iconMapping)) {
    if (nameLower.includes(keyword)) {
      selectedIcon = mapping.icon
      selectedColor = mapping.color
      if (descTemplates[keyword]) {
        description = descTemplates[keyword]
      }
      if (criteriaTemplates[keyword]) {
        criteria = criteriaTemplates[keyword]
      }
      break
    }
  }
  
  // If no specific match, generate contextual response
  if (description === `This badge recognizes outstanding achievement in ${badgeName.toLowerCase()}.`) {
    // Create a more personalized description based on the badge name
    const words = badgeName.split(' ').filter(w => w.length > 2)
    if (words.length > 0) {
      description = `Awarded for demonstrating exceptional qualities in ${badgeName}. This badge celebrates volunteers who exemplify the spirit of ${words[0].toLowerCase()} and contribute meaningfully to our organization's mission.`
      criteria = `Show consistent excellence in ${badgeName.toLowerCase()} activities. Meet the standards set by organization leadership and demonstrate commitment to this recognition area.`
    }
  }
  
  const badge = {
    name: badgeName || 'New Badge',
    description: description,
    icon_url: selectedIcon,
    color: selectedColor,
    criteria: criteria
  }
  
  res.json(badge)
})

// ==================== END BADGES API ====================

// ==================== DIRECT AID API ====================

// Get all active direct aids
app.get('/api/direct-aids', (req, res) => {
  const { status = 'active', approval_status } = req.query;
  
  let query = `
    SELECT 
      da.*,
      v.full_name as creator_name,
      v.avatar as creator_avatar
    FROM direct_aids da
    LEFT JOIN volunteers v ON da.created_by = v.id
    WHERE da.status = ?
  `;
  const params = [status];
  
  if (approval_status) {
    query += ` AND da.approval_status = ?`;
    params.push(approval_status);
  } else {
    // By default, only show approved direct aids
    query += ` AND da.approval_status = 'approved'`;
  }
  
  query += ` ORDER BY da.created_at DESC`;
  
  db.all(query, params, (err, aids) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(aids);
  });
});

// Get pending direct aids for approval
app.get('/api/direct-aids/admin/pending', (req, res) => {
  db.all(`
    SELECT 
      da.*,
      v.full_name as creator_name,
      v.avatar as creator_avatar
    FROM direct_aids da
    LEFT JOIN volunteers v ON da.created_by = v.id
    WHERE da.approval_status = 'pending'
    ORDER BY da.created_at DESC
  `, [], (err, aids) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(aids);
  });
});

// Approve direct aid
app.post('/api/direct-aids/:id/approve', (req, res) => {
  const { id } = req.params;
  
  db.run(`
    UPDATE direct_aids SET approval_status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Direct aid approved' });
  });
});

// Reject direct aid
app.post('/api/direct-aids/:id/reject', (req, res) => {
  const { id } = req.params;
  
  db.run(`
    UPDATE direct_aids SET approval_status = 'rejected', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Direct aid rejected' });
  });
});

// Get single direct aid with details
app.get('/api/direct-aids/:id', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT 
      da.*,
      v.full_name as host_name,
      v.avatar as host_avatar,
      v.phone as host_phone
    FROM direct_aids da
    LEFT JOIN volunteers v ON da.created_by = v.id
    WHERE da.id = ?
  `, [id], (err, aid) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!aid) return res.status(404).json({ error: 'Direct aid not found' });
    res.json(aid);
  });
});

// Get direct aid updates
app.get('/api/direct-aids/:id/updates', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT * FROM direct_aid_updates 
    WHERE direct_aid_id = ?
    ORDER BY created_at DESC
  `, [id], (err, updates) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(updates);
  });
});

// Get direct aid donations (funds)
app.get('/api/direct-aids/:id/donations', (req, res) => {
  const { id } = req.params;
  const { status } = req.query;
  
  let query = `
    SELECT 
      dad.*,
      v.full_name as donor_volunteer_name,
      v.avatar as donor_avatar
    FROM direct_aid_donations dad
    LEFT JOIN volunteers v ON dad.volunteer_id = v.id
    WHERE dad.direct_aid_id = ?
  `;
  
  const params = [id];
  
  if (status) {
    query += ' AND dad.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY dad.created_at DESC';
  
  db.all(query, params, (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations);
  });
});

// Submit a donation to direct aid
app.post('/api/direct-aids/:id/donate', (req, res) => {
  const { id } = req.params;
  const { 
    donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous,
    volunteerId
  } = req.body;

  // Validate required fields
  if (!amount || !paymentMethod || !transactionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isAnonymous && !donorName?.trim()) {
    return res.status(400).json({ error: 'Donor name is required for non-anonymous donations' });
  }

  // Insert donation record
  db.run(`
    INSERT INTO direct_aid_donations (
      direct_aid_id, donor_name, phone_number, amount, payment_method, 
      transaction_id, is_anonymous, volunteer_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `, [
    id, 
    isAnonymous ? 'Anonymous' : donorName, 
    phoneNumber, 
    amount, 
    paymentMethod, 
    transactionId, 
    isAnonymous ? 1 : 0,
    volunteerId || null
  ], function(err) {
    if (err) {
      console.error('Failed to insert direct aid donation:', err);
      return res.status(500).json({ error: 'Failed to record donation' });
    }

    res.json({ 
      id: this.lastID, 
      message: 'Donation recorded successfully. It will be verified soon.',
      status: 'pending'
    });
  });
});

// Get all pending direct aid donations (for approval)
app.get('/api/direct-aid-donations/pending', (req, res) => {
  db.all(`
    SELECT 
      dad.*,
      da.title as aid_title,
      da.image as aid_image,
      v.full_name as beneficiary_name
    FROM direct_aid_donations dad
    JOIN direct_aids da ON dad.direct_aid_id = da.id
    LEFT JOIN volunteers v ON da.volunteer_id = v.id
    WHERE dad.status = 'pending'
    ORDER BY dad.created_at DESC
  `, [], (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations);
  });
});

// Approve a direct aid donation
app.post('/api/direct-aid-donations/:id/approve', (req, res) => {
  const { id } = req.params;

  db.get(`
    SELECT dad.*, da.title as direct_aid_title 
    FROM direct_aid_donations dad
    JOIN direct_aids da ON da.id = dad.direct_aid_id
    WHERE dad.id = ?
  `, [id], (err, donation) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    // Update donation status to approved
    db.run(`
      UPDATE direct_aid_donations 
      SET status = 'approved', verified_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Update direct aid raised amount
      db.run(`
        UPDATE direct_aids 
        SET raised_amount = COALESCE(raised_amount, 0) + ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [donation.amount, donation.direct_aid_id], (updateErr) => {
        if (updateErr) {
          console.error('Failed to update direct aid raised amount:', updateErr);
        }
      });

      // Notify the donor about approval
      if (donation.volunteer_id) {
        createNotification(donation.volunteer_id, 'direct_aid_donation_approved',
          `Your donation of ৳${donation.amount} to "${donation.direct_aid_title}" has been approved! ✅`, {
            data: { directAidId: donation.direct_aid_id, amount: donation.amount },
            priority: 'normal'
        }).catch(console.error);
      }

      res.json({ message: 'Direct aid donation approved successfully' });
    });
  });
});

// Reject a direct aid donation
app.post('/api/direct-aid-donations/:id/reject', (req, res) => {
  const { id } = req.params;

  db.get(`
    SELECT dad.*, da.title as direct_aid_title 
    FROM direct_aid_donations dad
    JOIN direct_aids da ON da.id = dad.direct_aid_id
    WHERE dad.id = ?
  `, [id], (err, donation) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    db.run(`
      UPDATE direct_aid_donations 
      SET status = 'rejected', verified_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Notify the donor about rejection
      if (donation.volunteer_id) {
        createNotification(donation.volunteer_id, 'direct_aid_donation_rejected',
          `Your donation to "${donation.direct_aid_title}" needs attention. Please contact support.`, {
            data: { directAidId: donation.direct_aid_id },
            priority: 'high'
        }).catch(console.error);
      }
      
      res.json({ message: 'Direct aid donation rejected' });
    });
  });
});

// Get team members for a direct aid
app.get('/api/direct-aids/:id/team', (req, res) => {
  const { id } = req.params;
  
  db.all(`
    SELECT dat.*, v.full_name, v.avatar as photo
    FROM direct_aid_team dat
    LEFT JOIN volunteers v ON dat.volunteer_id = v.id
    WHERE dat.direct_aid_id = ?
    ORDER BY dat.role = 'host' DESC, dat.created_at ASC
  `, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Add team member to direct aid
app.post('/api/direct-aids/:id/team', (req, res) => {
  const { id } = req.params;
  const { volunteerId, role } = req.body;
  
  if (!volunteerId) {
    return res.status(400).json({ error: 'Volunteer ID is required' });
  }
  
  db.run(`
    INSERT OR IGNORE INTO direct_aid_team (direct_aid_id, volunteer_id, role, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `, [id, volunteerId, role || 'member'], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Team member added' });
  });
});

// Remove team member from direct aid
app.delete('/api/direct-aids/:id/team/:volunteerId', (req, res) => {
  const { id, volunteerId } = req.params;
  
  db.run(`
    DELETE FROM direct_aid_team WHERE direct_aid_id = ? AND volunteer_id = ?
  `, [id, volunteerId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Team member removed' });
  });
});

// Create a new direct aid
app.post('/api/direct-aids', (req, res) => {
  const { volunteerId, title, description, goalAmount, image, beneficiaryName, bio, lifeHistory, teamMembers } = req.body;

  if (!volunteerId || !title || !goalAmount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.run(`
    INSERT INTO direct_aids (volunteer_id, title, description, goal_amount, image, beneficiary_name, bio, life_history, status, approval_status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [volunteerId, title, description, goalAmount, image, beneficiaryName, bio, lifeHistory, volunteerId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    const directAidId = this.lastID;
    
    // Add creator as host
    db.run(`
      INSERT INTO direct_aid_team (direct_aid_id, volunteer_id, role, created_at)
      VALUES (?, ?, 'host', CURRENT_TIMESTAMP)
    `, [directAidId, volunteerId]);
    
    // Add team members
    if (teamMembers && teamMembers.length > 0) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO direct_aid_team (direct_aid_id, volunteer_id, role, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `);
      
      teamMembers.forEach(member => {
        stmt.run([directAidId, member.volunteerId, member.role || 'member']);
      });
      
      stmt.finalize();
    }
    
    res.json({ id: directAidId, message: 'Direct aid created successfully. Waiting for approval.' });
  });
});

// Add update to direct aid
app.post('/api/direct-aids/:id/updates', (req, res) => {
  const { id } = req.params;
  const { content, image, images, volunteerId } = req.body;

  if (!content && !images && !image) {
    return res.status(400).json({ error: 'Content or images required' });
  }

  // Use images array if provided, otherwise fall back to single image
  const imageData = images || (image ? JSON.stringify([image]) : null);

  db.run(`
    INSERT INTO direct_aid_updates (direct_aid_id, content, images, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `, [id, content, imageData], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Update added successfully' });
  });
});

// ==================== END DIRECT AID API ====================

// ==================== ANNOUNCEMENTS API ====================

// Get all announcements
app.get('/api/announcements', (req, res) => {
  db.all(`
    SELECT a.*, v.full_name as author_name, v.avatar as author_avatar, v.position as author_position
    FROM announcements a
    LEFT JOIN volunteers v ON a.created_by = v.id
    WHERE a.status = 'active'
    ORDER BY a.created_at DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get single announcement
app.get('/api/announcements/:id', (req, res) => {
  const { id } = req.params;
  db.get(`
    SELECT a.*, v.full_name as author_name, v.avatar as author_avatar, v.position as author_position
    FROM announcements a
    LEFT JOIN volunteers v ON a.created_by = v.id
    WHERE a.id = ?
  `, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Announcement not found' });
    res.json(row);
  });
});

// Create announcement
app.post('/api/announcements', (req, res) => {
  const { title, content, created_by, priority } = req.body;
  
  if (!title || !content || !created_by) {
    return res.status(400).json({ error: 'Title, content and created_by are required' });
  }

  db.run(`
    INSERT INTO announcements (title, content, created_by, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [title, content, created_by, priority || 'normal'], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    const announcementId = this.lastID;
    
    // Notify all active volunteers about the announcement
    db.all(`SELECT id FROM volunteers WHERE status = 'Active'`, [], (userErr, users) => {
      if (!userErr && users) {
        db.get('SELECT full_name, avatar FROM volunteers WHERE id = ?', [created_by], (actorErr, actor) => {
          const userIds = users.map(u => u.id);
          createBulkNotifications(userIds, 'announcement', 
            `New announcement: ${title}`, {
              title,
              data: { 
                announcementId, 
                preview: content.length > 100 ? content.slice(0, 100) + '...' : content 
              },
              actorId: created_by,
              actorName: actor?.full_name,
              actorAvatar: actor?.avatar,
              priority: priority === 'urgent' ? 'high' : 'normal'
          }).catch(console.error);
        });
      }
    });
    
    res.json({ id: announcementId, message: 'Announcement created successfully' });
  });
});

// Update announcement
app.put('/api/announcements/:id', (req, res) => {
  const { id } = req.params;
  const { title, content, priority, status } = req.body;

  db.run(`
    UPDATE announcements 
    SET title = COALESCE(?, title),
        content = COALESCE(?, content),
        priority = COALESCE(?, priority),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [title, content, priority, status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Announcement updated' });
  });
});

// Delete announcement
app.delete('/api/announcements/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM announcements WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Announcement deleted' });
  });
});

// ==================== END ANNOUNCEMENTS API ====================

// ==================== UMMAH FUND (TREASURY/VAULT) API ====================

// Get all ummah funds (vaults)
app.get('/api/ummah-funds', (req, res) => {
  const { type, entityId } = req.query;
  
  let query = `
    SELECT uf.*, 
           CASE 
             WHEN uf.entity_type = 'campaign' THEN c.title
             WHEN uf.entity_type = 'wing' THEN w.name
             WHEN uf.entity_type = 'direct_aid' THEN da.title
             ELSE 'UYHO Central Fund'
           END as entity_name,
           CASE 
             WHEN uf.entity_type = 'campaign' THEN c.image
             WHEN uf.entity_type = 'wing' THEN w.image
             WHEN uf.entity_type = 'direct_aid' THEN da.image
             ELSE NULL
           END as entity_image
    FROM ummah_funds uf
    LEFT JOIN campaigns c ON uf.entity_type = 'campaign' AND uf.entity_id = c.id
    LEFT JOIN wings w ON uf.entity_type = 'wing' AND uf.entity_id = w.id
    LEFT JOIN direct_aids da ON uf.entity_type = 'direct_aid' AND uf.entity_id = da.id
    WHERE 1=1
  `;
  
  const params = [];
  if (type) {
    query += ' AND uf.entity_type = ?';
    params.push(type);
  }
  if (entityId) {
    query += ' AND uf.entity_id = ?';
    params.push(entityId);
  }
  
  query += ' ORDER BY uf.balance DESC';
  
  db.all(query, params, (err, funds) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(funds || []);
  });
});

// Get central fund
app.get('/api/ummah-funds/central', (req, res) => {
  db.get(`
    SELECT * FROM ummah_funds WHERE entity_type = 'central' AND entity_id = 0
  `, (err, fund) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!fund) {
      // Create central fund if not exists
      db.run(`
        INSERT INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
        VALUES ('central', 0, 0, 0, 0)
      `, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, entity_type: 'central', entity_id: 0, balance: 0, total_in: 0, total_out: 0 });
      });
    } else {
      res.json(fund);
    }
  });
});

// Get fund for specific entity
app.get('/api/ummah-funds/:type/:entityId', (req, res) => {
  const { type, entityId } = req.params;
  
  db.get(`
    SELECT * FROM ummah_funds WHERE entity_type = ? AND entity_id = ?
  `, [type, entityId], (err, fund) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!fund) {
      // Create fund for entity if not exists
      db.run(`
        INSERT INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
        VALUES (?, ?, 0, 0, 0)
      `, [type, entityId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, entity_type: type, entity_id: parseInt(entityId), balance: 0, total_in: 0, total_out: 0 });
      });
    } else {
      res.json(fund);
    }
  });
});

// Get fund transactions
app.get('/api/ummah-funds/:type/:entityId/transactions', (req, res) => {
  const { type, entityId } = req.params;
  const { limit = 50 } = req.query;
  
  db.all(`
    SELECT ft.*,
           v.full_name as created_by_name,
           v.avatar as created_by_avatar,
           CASE 
             WHEN ft.from_type = 'campaign' THEN fc.title
             WHEN ft.from_type = 'wing' THEN fw.name
             WHEN ft.from_type = 'direct_aid' THEN fda.title
             ELSE 'UYHO Central Fund'
           END as from_name,
           CASE 
             WHEN ft.to_type = 'campaign' THEN tc.title
             WHEN ft.to_type = 'wing' THEN tw.name
             WHEN ft.to_type = 'direct_aid' THEN tda.title
             ELSE 'UYHO Central Fund'
           END as to_name
    FROM fund_transactions ft
    LEFT JOIN volunteers v ON ft.created_by = v.id
    LEFT JOIN campaigns fc ON ft.from_type = 'campaign' AND ft.from_id = fc.id
    LEFT JOIN wings fw ON ft.from_type = 'wing' AND ft.from_id = fw.id
    LEFT JOIN direct_aids fda ON ft.from_type = 'direct_aid' AND ft.from_id = fda.id
    LEFT JOIN campaigns tc ON ft.to_type = 'campaign' AND ft.to_id = tc.id
    LEFT JOIN wings tw ON ft.to_type = 'wing' AND ft.to_id = tw.id
    LEFT JOIN direct_aids tda ON ft.to_type = 'direct_aid' AND ft.to_id = tda.id
    WHERE (ft.from_type = ? AND ft.from_id = ?) OR (ft.to_type = ? AND ft.to_id = ?)
    ORDER BY ft.created_at DESC
    LIMIT ?
  `, [type, entityId, type, entityId, parseInt(limit)], (err, transactions) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(transactions || []);
  });
});

// Transfer funds between entities
app.post('/api/ummah-funds/transfer', (req, res) => {
  const { fromType, fromId, toType, toId, amount, note, createdBy } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  // Calculate available balance based on entity type (raised - expenses)
  let getBalanceQuery;
  if (fromType === 'campaign') {
    getBalanceQuery = `
      SELECT c.raised as total_raised,
             COALESCE((SELECT SUM(amount) FROM expenses WHERE entity_type = 'campaign' AND entity_id = c.id), 0) as total_expenses
      FROM campaigns c WHERE c.id = ?
    `;
  } else if (fromType === 'wing') {
    getBalanceQuery = `
      SELECT COALESCE((SELECT SUM(amount) FROM wing_donations WHERE wing_id = ? AND status = 'approved'), 0) as total_raised,
             COALESCE((SELECT SUM(amount) FROM expenses WHERE entity_type = 'wing' AND entity_id = ?), 0) as total_expenses
    `;
  } else {
    getBalanceQuery = `SELECT balance as total_raised, 0 as total_expenses FROM ummah_funds WHERE entity_type = ? AND entity_id = ?`;
  }
  
  db.get(getBalanceQuery, fromType === 'wing' ? [fromId, fromId] : [fromId], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const availableBalance = (result?.total_raised || 0) - (result?.total_expenses || 0);
    
    if (availableBalance < amount) {
      return res.status(400).json({ error: `Insufficient funds. Available: ৳${availableBalance}` });
    }
    
    // Record as expense to deduct from balance
    db.run(`
      INSERT INTO expenses (entity_type, entity_id, title, description, amount, category, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'Transfer', 'approved', ?)
    `, [fromType, fromId, `Transfer to ${toType}`, note || `Transfer of ৳${amount}`, amount, createdBy], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const expenseId = this.lastID;
      
      // Add to destination's raised amount or ummah_funds
      if (toType === 'campaign') {
        db.run(`UPDATE campaigns SET raised = raised + ? WHERE id = ?`, [amount, toId]);
      } else if (toType === 'wing') {
        // Add as wing donation
        db.run(`INSERT INTO wing_donations (wing_id, amount, status, payment_method, donor_name) VALUES (?, ?, 'approved', 'Transfer', 'Internal Transfer')`, [toId, amount]);
      } else {
        // Add to ummah_funds for central/direct_aid
        db.run(`
          INSERT INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            balance = balance + ?, total_in = total_in + ?, updated_at = CURRENT_TIMESTAMP
        `, [toType, toId, amount, amount, amount, amount]);
      }
      
      // Record transaction
      db.run(`
        INSERT INTO fund_transactions (from_type, from_id, to_type, to_id, amount, note, transaction_type, status, created_by, expense_id)
        VALUES (?, ?, ?, ?, ?, ?, 'transfer', 'completed', ?, ?)
      `, [fromType, fromId, toType, toId, amount, note, createdBy, expenseId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, message: 'Transfer completed' });
      });
    });
  });
});

// Add donation to fund (when campaign/wing receives donation)
app.post('/api/ummah-funds/deposit', (req, res) => {
  const { entityType, entityId, amount, source, note, createdBy, donationId } = req.body;
  
  db.run(`
    INSERT INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      balance = balance + ?, total_in = total_in + ?, updated_at = CURRENT_TIMESTAMP
  `, [entityType, entityId, amount, amount, amount, amount], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Record transaction
    db.run(`
      INSERT INTO fund_transactions (from_type, from_id, to_type, to_id, amount, note, transaction_type, status, created_by, donation_id)
      VALUES ('external', 0, ?, ?, ?, ?, 'deposit', 'completed', ?, ?)
    `, [entityType, entityId, amount, note || source, createdBy, donationId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Deposit recorded' });
    });
  });
});

// ==================== EXPENSES API ====================

// Get expenses for entity
app.get('/api/expenses/:type/:entityId', (req, res) => {
  const { type, entityId } = req.params;
  const { status } = req.query;
  
  let query = `
    SELECT e.*, v.full_name as created_by_name, v.avatar as created_by_avatar,
           av.full_name as approved_by_name
    FROM expenses e
    LEFT JOIN volunteers v ON e.created_by = v.id
    LEFT JOIN volunteers av ON e.approved_by = av.id
    WHERE e.entity_type = ? AND e.entity_id = ?
  `;
  const params = [type, entityId];
  
  if (status) {
    query += ' AND e.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY e.created_at DESC';
  
  db.all(query, params, (err, expenses) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(expenses || []);
  });
});

// Get expense summary for entity
app.get('/api/expenses/:type/:entityId/summary', (req, res) => {
  const { type, entityId } = req.params;
  
  db.get(`
    SELECT 
      COUNT(*) as total_count,
      SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as total_spent,
      SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count
    FROM expenses
    WHERE entity_type = ? AND entity_id = ?
  `, [type, entityId], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(summary || { total_count: 0, total_spent: 0, pending_amount: 0, pending_count: 0 });
  });
});

// Add expense
app.post('/api/expenses', (req, res) => {
  const { entityType, entityId, title, description, amount, category, invoiceImage, createdBy } = req.body;
  
  if (!entityType || !entityId || !title || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  db.run(`
    INSERT INTO expenses (entity_type, entity_id, title, description, amount, category, invoice_image, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `, [entityType, entityId, title, description, amount, category || 'General', invoiceImage, createdBy], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Expense added' });
  });
});

// Approve/reject expense
app.put('/api/expenses/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, approvedBy, note } = req.body;
  
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  db.run(`
    UPDATE expenses SET status = ?, approved_by = ?, approval_note = ?, approved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [status, approvedBy, note, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    // If approved, record in fund transactions
    if (status === 'approved') {
      db.get('SELECT * FROM expenses WHERE id = ?', [id], (err, expense) => {
        if (expense) {
          // First ensure fund exists (create with 0 balance if not)
          db.run(`
            INSERT OR IGNORE INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
            VALUES (?, ?, 0, 0, 0)
          `, [expense.entity_type, expense.entity_id], () => {
            // Deduct from fund
            db.run(`
              UPDATE ummah_funds SET balance = balance - ?, total_out = total_out + ?
              WHERE entity_type = ? AND entity_id = ?
            `, [expense.amount, expense.amount, expense.entity_type, expense.entity_id]);
            
            // Record transaction
            db.run(`
              INSERT INTO fund_transactions (from_type, from_id, to_type, to_id, amount, note, transaction_type, status, created_by, expense_id)
              VALUES (?, ?, 'expense', 0, ?, ?, 'expense', 'completed', ?, ?)
            `, [expense.entity_type, expense.entity_id, expense.amount, expense.title, approvedBy, expense.id]);
          });
        }
      });
    }
    
    res.json({ message: `Expense ${status}` });
  });
});

// Upload expense invoice
app.post('/api/expenses/upload-invoice', upload.single('invoice'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const invoiceUrl = `/avatars/${req.file.filename}`;
  res.json({ invoiceUrl });
});

// ==================== WING DONATIONS API ====================

// Get wing donations
app.get('/api/wings/:id/donations', (req, res) => {
  const { id } = req.params;
  const { status } = req.query;
  
  let query = `
    SELECT wd.*, v.full_name as donor_name_display, v.avatar as donor_avatar,
           rv.full_name as reviewed_by_name
    FROM wing_donations wd
    LEFT JOIN volunteers v ON wd.volunteer_id = v.id
    LEFT JOIN volunteers rv ON wd.reviewed_by = rv.id
    WHERE wd.wing_id = ?
  `;
  const params = [id];
  
  if (status) {
    query += ' AND wd.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY wd.created_at DESC';
  
  db.all(query, params, (err, donations) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(donations || []);
  });
});

// Add wing donation
app.post('/api/wings/:id/donations', (req, res) => {
  const { id } = req.params;
  const { donorName, phoneNumber, amount, paymentMethod, transactionId, isAnonymous, volunteerId } = req.body;
  
  if (!donorName || !amount || !paymentMethod || !transactionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  db.run(`
    INSERT INTO wing_donations (wing_id, donor_name, phone_number, amount, payment_method, transaction_id, is_anonymous, volunteer_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [id, donorName, phoneNumber, amount, paymentMethod, transactionId, isAnonymous ? 1 : 0, volunteerId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: 'Donation submitted for approval' });
  });
});

// Approve/reject wing donation
app.put('/api/wings/:wingId/donations/:donationId/status', (req, res) => {
  const { wingId, donationId } = req.params;
  const { status, reviewedBy } = req.body;
  
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  
  db.run(`
    UPDATE wing_donations SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND wing_id = ?
  `, [status, reviewedBy, donationId, wingId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    // If approved, add to wing fund
    if (status === 'approved') {
      db.get('SELECT * FROM wing_donations WHERE id = ?', [donationId], (err, donation) => {
        if (donation) {
          // Add to fund
          db.run(`
            INSERT INTO ummah_funds (entity_type, entity_id, balance, total_in, total_out)
            VALUES ('wing', ?, ?, ?, 0)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
              balance = balance + ?, total_in = total_in + ?, updated_at = CURRENT_TIMESTAMP
          `, [wingId, donation.amount, donation.amount, donation.amount, donation.amount]);
          
          // Record transaction
          db.run(`
            INSERT INTO fund_transactions (from_type, from_id, to_type, to_id, amount, note, transaction_type, status, created_by, donation_id)
            VALUES ('external', 0, 'wing', ?, ?, ?, 'deposit', 'completed', ?, ?)
          `, [wingId, donation.amount, `Donation from ${donation.donor_name}`, reviewedBy, donationId]);
        }
      });
    }
    
    res.json({ message: `Donation ${status}` });
  });
});

// Get wing fund summary
app.get('/api/wings/:id/fund-summary', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT 
      uf.balance,
      uf.total_in,
      uf.total_out,
      (SELECT COUNT(*) FROM wing_donations WHERE wing_id = ? AND status = 'pending') as pending_donations,
      (SELECT SUM(amount) FROM wing_donations WHERE wing_id = ? AND status = 'approved') as total_donations,
      (SELECT SUM(amount) FROM expenses WHERE entity_type = 'wing' AND entity_id = ? AND status = 'approved') as total_expenses
    FROM ummah_funds uf
    WHERE uf.entity_type = 'wing' AND uf.entity_id = ?
  `, [id, id, id, id], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(summary || { balance: 0, total_in: 0, total_out: 0, pending_donations: 0, total_donations: 0, total_expenses: 0 });
  });
});

// Get campaign fund summary
app.get('/api/campaigns/:id/fund-summary', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT 
      c.raised,
      c.goal,
      uf.balance,
      uf.total_in,
      uf.total_out,
      (SELECT COUNT(*) FROM donations WHERE campaign_id = ? AND status = 'pending') as pending_donations,
      (SELECT SUM(amount) FROM expenses WHERE entity_type = 'campaign' AND entity_id = ? AND status = 'approved') as total_expenses,
      (SELECT SUM(amount) FROM expenses WHERE entity_type = 'campaign' AND entity_id = ? AND status = 'pending') as pending_expenses
    FROM campaigns c
    LEFT JOIN ummah_funds uf ON uf.entity_type = 'campaign' AND uf.entity_id = c.id
    WHERE c.id = ?
  `, [id, id, id, id], (err, summary) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(summary || { raised: 0, goal: 0, balance: 0, total_in: 0, total_out: 0, pending_donations: 0, total_expenses: 0, pending_expenses: 0 });
  });
});

// Check if campaign has reached goal (for overflow handling)
app.get('/api/campaigns/:id/overflow-status', (req, res) => {
  const { id } = req.params;
  
  db.get(`
    SELECT id, title, raised, goal, 
           CASE WHEN raised >= goal THEN 1 ELSE 0 END as is_full,
           raised - goal as overflow_amount
    FROM campaigns WHERE id = ?
  `, [id], (err, campaign) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  });
});

// ==================== END UMMAH FUND API ====================

// ==================== PUSH NOTIFICATIONS API ====================

// Store push subscriptions
db.run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    volunteer_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    keys TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (volunteer_id) REFERENCES volunteers(id),
    UNIQUE(volunteer_id, endpoint)
  )
`)

// Subscribe to push notifications
app.post('/api/push/subscribe', (req, res) => {
  const { volunteerId, subscription } = req.body;
  
  if (!volunteerId || !subscription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  db.run(`
    INSERT OR REPLACE INTO push_subscriptions (volunteer_id, endpoint, keys, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `, [volunteerId, subscription.endpoint, JSON.stringify(subscription.keys)], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', (req, res) => {
  const { volunteerId, endpoint } = req.body;
  
  db.run(`DELETE FROM push_subscriptions WHERE volunteer_id = ? AND endpoint = ?`, 
    [volunteerId, endpoint], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Send notification to a specific user (internal use)
app.post('/api/push/send', async (req, res) => {
  const { volunteerId, title, body, url, data } = req.body;
  
  // Get user's subscriptions
  db.all(`SELECT * FROM push_subscriptions WHERE volunteer_id = ?`, [volunteerId], async (err, subscriptions) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // For now, just log - actual push requires web-push library
    console.log(`[Push] Sending notification to user ${volunteerId}:`, { title, body });
    
    // Store notification for in-app display
    db.run(`
      INSERT INTO notifications (volunteer_id, type, title, body, url, data, created_at)
      VALUES (?, 'push', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [volunteerId, title, body, url, JSON.stringify(data)]);
    
    res.json({ success: true, sent: subscriptions.length });
  });
});

// ==================== END PUSH NOTIFICATIONS API ====================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`)
  console.log(`Network accessible at http://192.168.0.5:${PORT}`)
})

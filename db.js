import mysql from 'mysql2';
import 'dotenv/config';

// MySQL Database Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'uyho_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Promisify for async/await
const promisePool = pool.promise();

// SQLite-compatible wrapper for MySQL
// This allows us to use the same API as SQLite (db.run, db.get, db.all)
const db = {
  // Run a query (INSERT, UPDATE, DELETE, CREATE)
  run: function(sql, params = [], callback) {
    // Convert SQLite syntax to MySQL
    let mysqlSql = convertToMySQL(sql);
    
    pool.query(mysqlSql, params, (err, result) => {
      if (callback) {
        if (err) {
          callback(err);
        } else {
          // Mimic SQLite's this.lastID and this.changes
          callback.call({ lastID: result.insertId, changes: result.affectedRows }, null);
        }
      }
    });
  },

  // Get single row
  get: function(sql, params = [], callback) {
    let mysqlSql = convertToMySQL(sql);
    
    pool.query(mysqlSql, params, (err, rows) => {
      if (callback) {
        callback(err, rows ? rows[0] : null);
      }
    });
  },

  // Get all rows
  all: function(sql, params = [], callback) {
    let mysqlSql = convertToMySQL(sql);
    
    pool.query(mysqlSql, params, (err, rows) => {
      if (callback) {
        callback(err, rows || []);
      }
    });
  },

  // Execute raw query (for migrations)
  exec: function(sql, callback) {
    pool.query(sql, (err) => {
      if (callback) callback(err);
    });
  },

  // Close connection
  close: function(callback) {
    pool.end(callback);
  }
};

// Convert SQLite syntax to MySQL
function convertToMySQL(sql) {
  let converted = sql
    // AUTOINCREMENT -> AUTO_INCREMENT
    .replace(/AUTOINCREMENT/gi, 'AUTO_INCREMENT')
    // INTEGER PRIMARY KEY -> INT PRIMARY KEY
    .replace(/INTEGER PRIMARY KEY/gi, 'INT PRIMARY KEY')
    // DATETIME DEFAULT CURRENT_TIMESTAMP -> DATETIME DEFAULT CURRENT_TIMESTAMP
    .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'DATETIME DEFAULT CURRENT_TIMESTAMP')
    // TEXT -> TEXT (no change needed)
    // REAL -> DOUBLE
    .replace(/\bREAL\b/gi, 'DOUBLE')
    // Remove IF NOT EXISTS for ALTER TABLE (MySQL handles differently)
    // SQLite's PRAGMA -> skip entirely
    .replace(/PRAGMA[^;]*/gi, 'SELECT 1');
  
  return converted;
}

// Initialize MySQL database with all tables
export async function initializeMySQLDatabase() {
  console.log('[MySQL] Initializing database tables...');
  
  const tables = [
    // Team members table
    `CREATE TABLE IF NOT EXISTS team_members (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      position VARCHAR(255) NOT NULL,
      specialty VARCHAR(255),
      image_url TEXT,
      category VARCHAR(100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Volunteers table
    `CREATE TABLE IF NOT EXISTS volunteers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      age INT,
      address TEXT,
      wing VARCHAR(255),
      avatar TEXT,
      education TEXT,
      position VARCHAR(100) DEFAULT 'Member',
      lives_impacted INT DEFAULT 0,
      teams_led INT DEFAULT 0,
      hours_given INT DEFAULT 0,
      respect_points INT DEFAULT 0,
      availability TEXT,
      digital_id VARCHAR(100) UNIQUE NOT NULL,
      total_hours INT DEFAULT 0,
      projects INT DEFAULT 0,
      points INT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Active',
      last_active DATETIME,
      total_donated DOUBLE DEFAULT 0,
      total_collected DOUBLE DEFAULT 0,
      donation_points INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,

    // Campaigns table
    `CREATE TABLE IF NOT EXISTS campaigns (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      wing VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      budget DOUBLE DEFAULT 0,
      logistics DOUBLE DEFAULT 0,
      equipment DOUBLE DEFAULT 0,
      marketing DOUBLE DEFAULT 0,
      image TEXT,
      location VARCHAR(255) DEFAULT 'TBD',
      volunteers_joined INT DEFAULT 0,
      volunteers_needed INT DEFAULT 10,
      raised DOUBLE DEFAULT 0,
      goal DOUBLE DEFAULT 0,
      days_left INT DEFAULT 30,
      urgency INT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Active',
      host_id INT,
      budget_breakdown TEXT,
      event_date VARCHAR(100),
      program_hours INT DEFAULT 0,
      program_respect INT DEFAULT 0,
      lives_impacted INT DEFAULT 0,
      approval_status VARCHAR(50) DEFAULT 'pending',
      decline_reason TEXT,
      reviewed_by INT,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (host_id) REFERENCES volunteers(id) ON DELETE SET NULL
    )`,

    // Campaign team members table
    `CREATE TABLE IF NOT EXISTS campaign_team (
      id INT PRIMARY KEY AUTO_INCREMENT,
      campaign_id INT NOT NULL,
      volunteer_id INT NOT NULL,
      role VARCHAR(255) NOT NULL,
      task_note TEXT,
      hours INT DEFAULT 0,
      respect INT DEFAULT 0,
      approval_status VARCHAR(50) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Activities table
    `CREATE TABLE IF NOT EXISTS activities (
      id INT PRIMARY KEY AUTO_INCREMENT,
      volunteer_id INT NOT NULL,
      activity_type VARCHAR(100) NOT NULL,
      description TEXT NOT NULL,
      campaign_id INT,
      campaign_title VARCHAR(255),
      role VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    )`,

    // Allies table
    `CREATE TABLE IF NOT EXISTS allies (
      id INT PRIMARY KEY AUTO_INCREMENT,
      volunteer_id INT NOT NULL,
      ally_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (ally_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_ally (volunteer_id, ally_id)
    )`,

    // Conversations table
    `CREATE TABLE IF NOT EXISTS conversations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      participant1_id INT NOT NULL,
      participant2_id INT NOT NULL,
      last_message_id INT,
      last_message_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (participant1_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (participant2_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_conversation (participant1_id, participant2_id)
    )`,

    // Messages table
    `CREATE TABLE IF NOT EXISTS messages (
      id INT PRIMARY KEY AUTO_INCREMENT,
      conversation_id INT,
      group_id INT,
      sender_id INT NOT NULL,
      content TEXT,
      message_type VARCHAR(50) DEFAULT 'text',
      file_url TEXT,
      file_name VARCHAR(255),
      file_size INT,
      is_read TINYINT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'sent',
      delivered_at DATETIME,
      read_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Group chats table
    `CREATE TABLE IF NOT EXISTS group_chats (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      avatar TEXT,
      creator_id INT NOT NULL,
      allow_member_add TINYINT DEFAULT 0,
      join_approval_required TINYINT DEFAULT 0,
      last_message_id INT,
      last_message_at DATETIME,
      wing_id INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Group join requests table
    `CREATE TABLE IF NOT EXISTS group_join_requests (
      id INT PRIMARY KEY AUTO_INCREMENT,
      group_id INT NOT NULL,
      user_id INT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INT,
      reviewed_at DATETIME,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_request (group_id, user_id)
    )`,

    // Group members table
    `CREATE TABLE IF NOT EXISTS group_members (
      id INT PRIMARY KEY AUTO_INCREMENT,
      group_id INT NOT NULL,
      user_id INT NOT NULL,
      is_admin TINYINT DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_member (group_id, user_id)
    )`,

    // Pinned chats table
    `CREATE TABLE IF NOT EXISTS pinned_chats (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      conversation_id INT,
      group_id INT,
      pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE
    )`,

    // Muted chats table
    `CREATE TABLE IF NOT EXISTS muted_chats (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      conversation_id INT,
      group_id INT,
      muted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Blocked users table
    `CREATE TABLE IF NOT EXISTS blocked_users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      blocked_user_id INT NOT NULL,
      blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_block (user_id, blocked_user_id)
    )`,

    // Privacy settings table
    `CREATE TABLE IF NOT EXISTS privacy_settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL UNIQUE,
      allies_visibility VARCHAR(50) DEFAULT 'public',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Organization settings table
    `CREATE TABLE IF NOT EXISTS organization_settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      org_name VARCHAR(255) DEFAULT 'UYHO',
      org_full_name VARCHAR(255) DEFAULT 'United Young Help Organization',
      org_description TEXT,
      org_logo TEXT,
      org_logo_dark TEXT,
      contact_email VARCHAR(255),
      contact_phone VARCHAR(100),
      contact_address TEXT,
      website_url VARCHAR(255),
      facebook_url VARCHAR(255),
      instagram_url VARCHAR(255),
      twitter_url VARCHAR(255),
      linkedin_url VARCHAR(255),
      youtube_url VARCHAR(255),
      tiktok_url VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,

    // Wings table
    `CREATE TABLE IF NOT EXISTS wings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      bio TEXT,
      image TEXT,
      cover_image TEXT,
      location VARCHAR(255),
      join_approval_required TINYINT DEFAULT 0,
      projects_count INT DEFAULT 0,
      approval_status VARCHAR(50) DEFAULT 'pending',
      decline_reason TEXT,
      reviewed_by INT,
      reviewed_at DATETIME,
      created_by INT,
      parent_wing_id INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,

    // Wing members table
    `CREATE TABLE IF NOT EXISTS wing_members (
      id INT PRIMARY KEY AUTO_INCREMENT,
      wing_id INT NOT NULL,
      volunteer_id INT NOT NULL,
      role VARCHAR(100) NOT NULL DEFAULT 'Wing Member',
      sort_order INT DEFAULT 7,
      is_parent TINYINT DEFAULT 0,
      is_admin TINYINT DEFAULT 0,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wing_id) REFERENCES wings(id) ON DELETE CASCADE,
      FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_wing_member (wing_id, volunteer_id)
    )`,

    // Wing posts table
    `CREATE TABLE IF NOT EXISTS wing_posts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      wing_id INT NOT NULL,
      author_id INT NOT NULL,
      content TEXT NOT NULL,
      image TEXT,
      video TEXT,
      likes_count INT DEFAULT 0,
      comments_count INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (wing_id) REFERENCES wings(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Wing post likes table
    `CREATE TABLE IF NOT EXISTS wing_post_likes (
      id INT PRIMARY KEY AUTO_INCREMENT,
      post_id INT NOT NULL,
      user_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES wing_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_like (post_id, user_id)
    )`,

    // Wing post comments table
    `CREATE TABLE IF NOT EXISTS wing_post_comments (
      id INT PRIMARY KEY AUTO_INCREMENT,
      post_id INT NOT NULL,
      user_id INT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES wing_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Courses table
    `CREATE TABLE IF NOT EXISTS courses (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      instructor VARCHAR(255) NOT NULL,
      instructor_id INT,
      image TEXT,
      duration VARCHAR(100),
      modules INT DEFAULT 0,
      description TEXT,
      wing VARCHAR(255),
      status VARCHAR(50) DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (instructor_id) REFERENCES volunteers(id) ON DELETE SET NULL
    )`,

    // Course modules table
    `CREATE TABLE IF NOT EXISTS course_modules (
      id INT PRIMARY KEY AUTO_INCREMENT,
      course_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      order_index INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    )`,

    // Course lessons table
    `CREATE TABLE IF NOT EXISTS course_lessons (
      id INT PRIMARY KEY AUTO_INCREMENT,
      module_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      video_url TEXT,
      content TEXT,
      slide_url TEXT,
      duration VARCHAR(50),
      order_index INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (module_id) REFERENCES course_modules(id) ON DELETE CASCADE
    )`,

    // Course enrollments table
    `CREATE TABLE IF NOT EXISTS course_enrollments (
      id INT PRIMARY KEY AUTO_INCREMENT,
      course_id INT NOT NULL,
      user_id INT NOT NULL,
      progress INT DEFAULT 0,
      completed_lessons TEXT,
      enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_enrollment (course_id, user_id)
    )`,

    // Certificates table
    `CREATE TABLE IF NOT EXISTS certificates (
      id INT PRIMARY KEY AUTO_INCREMENT,
      certificate_id VARCHAR(100) UNIQUE NOT NULL,
      user_id INT NOT NULL,
      course_id INT NOT NULL,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    )`,

    // Donations table
    `CREATE TABLE IF NOT EXISTS donations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      donor_id INT,
      donor_name VARCHAR(255),
      donor_email VARCHAR(255),
      donor_phone VARCHAR(100),
      amount DOUBLE NOT NULL,
      payment_method VARCHAR(100),
      transaction_id VARCHAR(255),
      campaign_id INT,
      message TEXT,
      is_anonymous TINYINT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'completed',
      collected_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (donor_id) REFERENCES volunteers(id) ON DELETE SET NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
      FOREIGN KEY (collected_by) REFERENCES volunteers(id) ON DELETE SET NULL
    )`,

    // Direct aid table
    `CREATE TABLE IF NOT EXISTS direct_aid (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      requester_id INT NOT NULL,
      amount DOUBLE DEFAULT 0,
      status VARCHAR(50) DEFAULT 'pending',
      category VARCHAR(100),
      urgency VARCHAR(50) DEFAULT 'normal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Announcements table
    `CREATE TABLE IF NOT EXISTS announcements (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      author_id INT NOT NULL,
      priority VARCHAR(50) DEFAULT 'normal',
      wing_id INT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (wing_id) REFERENCES wings(id) ON DELETE SET NULL
    )`,

    // Notifications table
    `CREATE TABLE IF NOT EXISTS notifications (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      type VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      link VARCHAR(255),
      is_read TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Push subscriptions table
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh VARCHAR(255),
      auth VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE
    )`,

    // Badges table
    `CREATE TABLE IF NOT EXISTS badges (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      icon VARCHAR(100),
      color VARCHAR(50),
      requirement_type VARCHAR(100),
      requirement_value INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // User badges table
    `CREATE TABLE IF NOT EXISTS user_badges (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      badge_id INT NOT NULL,
      earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE,
      UNIQUE KEY unique_user_badge (user_id, badge_id)
    )`,

    // Programs table
    `CREATE TABLE IF NOT EXISTS programs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      wing_id INT,
      status VARCHAR(50) DEFAULT 'active',
      start_date DATE,
      end_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wing_id) REFERENCES wings(id) ON DELETE SET NULL
    )`,

    // Ally requests table
    `CREATE TABLE IF NOT EXISTS ally_requests (
      id INT PRIMARY KEY AUTO_INCREMENT,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_ally_request (sender_id, receiver_id)
    )`,

    // Wing join requests table
    `CREATE TABLE IF NOT EXISTS wing_join_requests (
      id INT PRIMARY KEY AUTO_INCREMENT,
      wing_id INT NOT NULL,
      user_id INT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_by INT,
      reviewed_at DATETIME,
      FOREIGN KEY (wing_id) REFERENCES wings(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES volunteers(id) ON DELETE CASCADE,
      UNIQUE KEY unique_wing_request (wing_id, user_id)
    )`
  ];

  // Create tables sequentially
  for (const sql of tables) {
    try {
      await promisePool.query(sql);
    } catch (err) {
      // Ignore "table already exists" errors
      if (!err.message.includes('already exists')) {
        console.error('[MySQL] Table creation error:', err.message);
      }
    }
  }

  // Insert default organization settings
  try {
    const [rows] = await promisePool.query('SELECT COUNT(*) as count FROM organization_settings');
    if (rows[0].count === 0) {
      await promisePool.query(`
        INSERT INTO organization_settings (org_name, org_full_name, org_description, contact_email, website_url)
        VALUES (?, ?, ?, ?, ?)
      `, [
        'UYHO',
        'United Young Help Organization',
        'United Young Help Organization (UYHO) is a youth-led nonprofit dedicated to empowering communities through volunteerism, education, and humanitarian aid.',
        'contact@uyho.org',
        'https://uyho.org'
      ]);
    }
  } catch (err) {
    // Ignore if already exists
  }

  console.log('[MySQL] Database initialization complete!');
}

// Test connection
export async function testConnection() {
  try {
    const [rows] = await promisePool.query('SELECT 1');
    console.log('[MySQL] Connection successful!');
    return true;
  } catch (err) {
    console.error('[MySQL] Connection failed:', err.message);
    return false;
  }
}

export { db, pool, promisePool };
export default db;

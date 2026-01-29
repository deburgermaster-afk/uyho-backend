# UYHO Backend API

Backend API server for UYHO (United Young Help Organization) volunteer management system.

## Deployment to Fly.io

### Prerequisites
1. Install Fly CLI: `brew install flyctl` (macOS) or see [Fly.io docs](https://fly.io/docs/hands-on/install-flyctl/)
2. Sign up/Login: `fly auth signup` or `fly auth login`

### Deploy Steps

1. **Launch the app** (first time only):
   ```bash
   fly launch --no-deploy
   ```
   - Choose a unique app name or accept the generated one
   - Select region closest to your users (e.g., `sin` for Singapore)
   - Say "No" to database creation (you're using external MySQL)

2. **Set environment variables**:
   ```bash
   fly secrets set DB_HOST=your-mysql-host.com
   fly secrets set DB_PORT=3306
   fly secrets set DB_NAME=uyho_db
   fly secrets set DB_USER=your_db_user
   fly secrets set DB_PASSWORD=your_db_password
   fly secrets set FRONTEND_URL=https://uyho.org
   ```

3. **Deploy**:
   ```bash
   fly deploy
   ```

4. **Get your app URL**:
   ```bash
   fly status
   ```
   Your API will be at: `https://your-app-name.fly.dev`

### Custom Domain Setup

1. Add your domain in Fly.io:
   ```bash
   fly certs add api.uyho.org
   ```

2. Add DNS records (in your domain registrar):
   - **CNAME**: `api` → `your-app-name.fly.dev`
   
   Or for root domain:
   - **A**: `@` → (Fly.io IP from `fly ips list`)
   - **AAAA**: `@` → (Fly.io IPv6 from `fly ips list`)

3. Wait for certificate provisioning (usually 1-5 minutes)

### Useful Commands

- View logs: `fly logs`
- SSH into container: `fly ssh console`
- Check status: `fly status`
- Scale: `fly scale count 1`
- Restart: `fly apps restart`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| DB_HOST | MySQL database host | Yes |
| DB_PORT | MySQL port (default: 3306) | No |
| DB_NAME | Database name | Yes |
| DB_USER | Database username | Yes |
| DB_PASSWORD | Database password | Yes |
| FRONTEND_URL | Frontend URL for CORS | Yes |
| PORT | Server port (set by Fly.io) | No |

## API Endpoints

All endpoints are prefixed with `/api`

- `GET /health` - Health check
- `POST /api/volunteers/register` - Register new volunteer
- `POST /api/volunteers/login` - Login
- `GET /api/volunteers/:id` - Get volunteer profile
- ... and many more

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your database credentials
npm start
```

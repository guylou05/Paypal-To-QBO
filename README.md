# PayPal → QuickBooks Online Reconciliation Tool

A secure, admin-only web tool that:

1. Pulls PayPal transaction history via the REST API
2. Classifies each transaction (sale, fee, PayPal Credit, transfer, noise, etc.)
3. Queues them for human review — **nothing posts to QuickBooks without approval**
4. Posts approved transactions to QuickBooks Online as correct accounting entries
5. Keeps an auditable log of every action

---

## Architecture

| Layer      | Tech                                           |
|------------|------------------------------------------------|
| Backend    | Node.js 20 + Express                           |
| Frontend   | React 18 + Vite + Tailwind CSS                 |
| Database   | PostgreSQL 16                                  |
| Auth       | JWT in httpOnly cookie                         |
| Tokens     | AES-256-GCM encrypted at rest                  |
| Deploy     | Docker + docker-compose                        |

---

## Prerequisites

- Docker & Docker Compose
- A [PayPal developer account](https://developer.paypal.com) with a REST app
- An [Intuit developer account](https://developer.intuit.com) with a QuickBooks Online app

---

## Quick Start (Docker)

### 1. Clone and configure

```bash
git clone <repo>
cd paypal-qbo-reconciler
cp .env.example .env
```

Edit `.env`:

```bash
# Generate secrets:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY

DB_PASSWORD=your_strong_db_password
JWT_SECRET=<64-hex-char string>
ENCRYPTION_KEY=<32-hex-char string>   # exactly 64 hex chars = 32 bytes

QBO_CLIENT_ID=your_intuit_client_id
QBO_CLIENT_SECRET=your_intuit_client_secret
QBO_REDIRECT_URI=http://your-server:3001/api/quickbooks/callback
QBO_ENVIRONMENT=sandbox   # change to 'production' when ready

PAYPAL_ENVIRONMENT=sandbox   # change to 'live' for production

ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=your_secure_password
```

### 2. Start with Docker Compose

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432 (internal)
- Backend API on port 3001
- Frontend (nginx) on port 3000

The backend auto-runs migrations on first start.

### 3. Seed the admin user

```bash
docker-compose exec backend npm run seed
```

### 4. Open the app

Navigate to **http://localhost:3000** and log in with your admin credentials.

---

## Development (without Docker)

### Backend

```bash
cd backend
npm install

# Start PostgreSQL separately (or use docker-compose -f docker-compose.dev.yml up db)

cp ../.env.example .env  # edit as needed
npm run migrate
npm run seed
npm run dev
```

Backend runs on `http://localhost:3001`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:3000`. The Vite dev server proxies `/api` to `localhost:3001`.

---

## Setup Wizard (in-app)

After logging in, go to **Setup** and complete the three steps:

### Step 1 — PayPal API Credentials
1. Log in to [developer.paypal.com](https://developer.paypal.com)
2. Create a REST app (or use sandbox for testing)
3. Copy the **Client ID** and **Secret**
4. Paste into Setup → verify

Credentials are stored AES-256-GCM encrypted. Never stored in plaintext.

### Step 2 — QuickBooks Online OAuth
1. Log in to [developer.intuit.com](https://developer.intuit.com)
2. Create an app with scope: **Accounting**
3. Add your redirect URI: `http://your-server:3001/api/quickbooks/callback`
4. Set `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in `.env`
5. Click **Connect QuickBooks Online** in the UI
6. Authorize via Intuit's OAuth page

### Step 3 — Account Mapping
Map each PayPal category to a QuickBooks account:

| Key                  | What to map it to                             |
|----------------------|-----------------------------------------------|
| `paypal_bank`        | Bank account representing your PayPal balance |
| `paypal_credit`      | Credit Card liability for PayPal Credit (BML) |
| `paypal_fees`        | Expense account for PayPal fees               |
| `paypal_sales`       | Income account for PayPal revenue             |
| `paypal_adjustments` | COGS or adjustment account                    |
| `bank_account_1`     | Your primary linked bank account              |
| `bank_account_2`     | Secondary bank account (optional)             |
| `uncategorized`      | Holding/suspense account for review items     |

---

## Workflow

```
Import → Classify → Review → Approve → Sync → Audit
```

1. **Import** — Go to *Import Transactions*, pick a date range, click Import
   - Transactions are fetched from PayPal API (all pages)
   - Raw payloads stored verbatim
   - Duplicate detection by PayPal transaction ID
   - Classifier runs automatically

2. **Review Queue** — Every transaction has a status:
   - `imported` → just arrived
   - `classified` → classifier matched a rule
   - `needs_review` → low confidence or ambiguous
   - `approved` → ready to sync
   - `synced` → posted to QBO
   - `ignored` → skipped (noise, holds, etc.)
   - `failed` → sync attempted but QBO returned error

3. **Approve** — Use bulk approve for batches, or edit individual items
   - Override category if classifier got it wrong
   - Override QBO account if needed
   - Add reviewer notes

4. **Sync to QBO** — Post approved transactions
   - Each transaction is posted as the correct QBO object type
   - QBO object ID is stored for rollback
   - Failures are logged and can be retried

5. **Rollback** — Delete a posted QBO entry and reset to Approved

---

## Transaction Classification

| Category                  | Detection                                             | QBO Entry               |
|---------------------------|-------------------------------------------------------|-------------------------|
| `sale`                    | T0006/T0016/etc, gross > 0, status S                  | Journal Entry (Dr Bank, Dr Fees, Cr Income) |
| `paypal_fee`              | T0007 or fee keywords, gross < 0                      | Journal Entry (Dr Fees, Cr Bank) |
| `paypal_credit_purchase`  | funding=paypal_credit, BML/Buyer Credit/PayPal Credit | Journal Entry (Dr Expense, Cr Credit) |
| `paypal_credit_repayment` | "Buyer Credit Payment", "Transfer To BML"             | Journal Entry (Dr Credit, Cr Bank) |
| `bank_transfer_in`        | T1201, "add funds", "bank deposit"                    | QBO Transfer |
| `bank_transfer_out`       | T1202, "withdrawal"                                   | QBO Transfer |
| `refund`                  | T1106/T1107/T1108, "refund", "reversal"               | Journal Entry (reversed sale) |
| `noise`                   | Authorization, Account Hold, Reversal of Hold         | **Ignored by default** |
| `unknown`                 | No rule matched                                       | **Sent to needs_review** |

Custom rules can be added in **Settings → Classification Rules**.

---

## Security

- JWT tokens stored in `httpOnly` cookies (not accessible to JavaScript)
- PayPal credentials encrypted with AES-256-GCM before DB storage
- QBO OAuth tokens encrypted at rest
- Rate limiting on all API routes (strict on login)
- Helmet security headers
- Input validation on all endpoints via express-validator
- No secrets ever sent to the frontend

---

## Database Schema

```
users                   → admin accounts
settings                → encrypted PayPal credentials
oauth_tokens            → encrypted PayPal + QBO tokens
account_mappings        → PayPal category → QBO account ID
import_batches          → date-range import records
raw_paypal_transactions → verbatim PayPal API payloads
normalized_transactions → processed, classified, reviewed
classification_rules    → custom admin-defined rules
qbo_sync_logs           → every QBO API call (with payloads)
rollback_logs           → QBO delete actions
audit_logs              → every user action
```

---

## VPS Deployment

### 1. Provision a server (Ubuntu 22.04+)

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
```

### 2. Set up DNS

Point your domain to the server IP. Update `.env`:
```
QBO_REDIRECT_URI=https://yourdomain.com/api/quickbooks/callback
FRONTEND_URL=https://yourdomain.com
VITE_API_URL=https://yourdomain.com
```

### 3. Use a reverse proxy (nginx + certbot)

Install nginx and certbot, then proxy:
- `yourdomain.com` → port 3000 (frontend)
- `yourdomain.com/api` → port 3001 (backend)

Or configure the backend to serve the frontend's `dist/` folder:
```bash
# In production, copy frontend build into backend/public/
cd frontend && npm run build
cp -r dist ../backend/public
```

Then in `backend/src/app.js` add:
```js
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
```

### 4. TLS / HTTPS

QuickBooks **requires** HTTPS for the OAuth callback in production.

---

## Environment Variables Reference

| Variable              | Required | Description |
|-----------------------|----------|-------------|
| `DB_HOST`             | Yes      | PostgreSQL host |
| `DB_PORT`             | No       | Default: 5432 |
| `DB_NAME`             | Yes      | Database name |
| `DB_USER`             | Yes      | DB username |
| `DB_PASSWORD`         | Yes      | DB password |
| `JWT_SECRET`          | Yes      | 64+ hex chars |
| `ENCRYPTION_KEY`      | Yes      | Exactly 64 hex chars (32 bytes) |
| `QBO_CLIENT_ID`       | Yes      | Intuit app client ID |
| `QBO_CLIENT_SECRET`   | Yes      | Intuit app client secret |
| `QBO_REDIRECT_URI`    | Yes      | OAuth callback URL (must match Intuit app settings) |
| `QBO_ENVIRONMENT`     | No       | `sandbox` or `production` |
| `PAYPAL_ENVIRONMENT`  | No       | `sandbox` or `live` |
| `FRONTEND_URL`        | Yes      | Frontend URL for CORS |
| `PORT`                | No       | Backend port, default 3001 |
| `ADMIN_EMAIL`         | Seed     | Initial admin email |
| `ADMIN_PASSWORD`      | Seed     | Initial admin password |

---

## Known Limitations & Future Work

- **Multi-tenant**: The schema is single-business. To extend, add a `business_id` foreign key to all tables and filter all queries by it.
- **CSV import**: Not yet implemented. Planned as fallback for PayPal's limited sandbox data.
- **Webhooks**: Not yet implemented. Planned for real-time transaction ingestion.
- **Sales Receipts**: Currently uses Journal Entries for all non-transfer transactions. Proper Sales Receipts require a QBO Item reference — add `income_item_ref` to account mappings to enable.
- **Token refresh scheduling**: Currently token refresh is lazy (on next API call). Add a cron job for proactive refresh if needed.

---

## License

MIT

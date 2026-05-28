# AccountantBot — Automated Expense Management RPA

An n8n-based RPA prototype that turns Discord-submitted receipt photos into structured rows in a Google Sheet, using any OpenAI-compatible vision LLM for OCR/extraction and MongoDB for workflow logging.

## How it works

1. A Discord bot forwards a receipt image (base64) to an n8n webhook.
2. n8n sends the image to your configured LLM endpoint (`/chat/completions`), which returns structured JSON.
3. The workflow validates required fields, then appends a row to a Google Sheet.
4. Discord is notified of the outcome (Approved / Pending Review / Rejected).
5. Every step is logged to a MongoDB collection.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- An API key for any **OpenAI-compatible** chat completions endpoint with a **vision-capable** model (OpenAI, Groq, OpenRouter, Anthropic, Ollama, vLLM, etc.)
- A Discord webhook URL and an "accountant" role ID (for mentions)
- A Google account with a Google Sheet to receive the expense rows
- A Google Cloud project with OAuth credentials for the Google Sheets API (used by n8n to write rows)

## 1. Clone and configure

```powershell
git clone <this-repo>
cd AccountantBot-SoftwareRoboticsExamProject
copy .example.env .env
```

Edit [.env](.env) and fill in:

| Variable | What it is |
|---|---|
| `LLM_BASE_URL` | Base URL of an OpenAI-compatible API (e.g. `https://api.openai.com/v1`) |
| `LLM_API_KEY` | API key for that endpoint |
| `LLM_MODEL` | Model name. Must support image input (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-latest`, `llama-3.2-90b-vision-preview`, `llava`) |
| `DISCORD_BOT_TOKEN` | Bot token for the bundled Discord bot (from the Discord Developer Portal) |
| `DISCORD_EXPENSE_CHANNEL_ID` | ID of the Discord channel the bot listens in for receipt uploads |
| `DISCORD_LOG_WEBHOOK_URL` | Discord channel webhook URL n8n posts status messages to |
| `N8N_WEBHOOK_URL` | Full URL of the n8n webhook the bot forwards receipts to (filled in after step 6 — see below) |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The spreadsheet ID from the Google Sheets URL |
| `GOOGLE_SHEETS_SHEET_NAME` | Tab name within the sheet (default `Expenses`) |
| `MONGO_ROOT_USERNAME` / `MONGO_ROOT_PASSWORD` | Mongo admin credentials |
| `MONGO_DATABASE` | Mongo database name (default `expense_rpa`) |
| `MONGO_LOG_COLLECTION` | Mongo collection for logs (default `workflow_logs`) |

`N8N_WEBHOOK_URL` is the only one you cannot fill in yet — leave it as the placeholder for now, you'll come back to it after activating the workflow.

### LLM endpoint examples

| Provider | `LLM_BASE_URL` | Example `LLM_MODEL` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.2-90b-vision-preview` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-sonnet` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-3-5-sonnet-latest` |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `llava` |

### Discord bot setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a **Bot** user. Copy the bot token into `DISCORD_BOT_TOKEN`.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Invite the bot to your server with `bot` scope and at least the `Read Messages` + `Send Messages` + `Read Message History` + `Add Reactions` permissions.
4. Right-click the channel that should receive receipt uploads → **Copy Channel ID** (requires Developer Mode in Discord settings) → paste into `DISCORD_EXPENSE_CHANNEL_ID`.
5. In the same (or a different) channel, create a **Webhook** under channel settings and paste its URL into `DISCORD_LOG_WEBHOOK_URL`. n8n uses this to post Approved / Pending Review / Rejected status updates.

## 2. Prepare the Google Sheet

1. Create a Google Sheet and add a tab named `Expenses` (or match `GOOGLE_SHEETS_SHEET_NAME`).
2. Add a header row with these columns **in this exact order**:

```
SubmittedDate | MessageTimestamp | DiscordUser | DiscordUserId | ReceiptId |
Merchant | ReceiptDate | Category | Currency | TotalAmount | VATAmount |
PaymentMethod | BusinessPurpose | Status | Details | Confidence | MessageId
```

3. Copy the **spreadsheet ID** from the URL — it's the long string between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`<this part>`**`/edit#gid=0` — paste it into `GOOGLE_SHEETS_SPREADSHEET_ID`.

## 3. Start the stack

```powershell
docker compose up -d
```

This launches three containers:
- **n8n** at http://localhost:5678 (volume: `n8n_accountantbot_data`) — runs the workflow
- **MongoDB** at `localhost:27017` (volume: `mongo_accountantbot_data`) — stores workflow logs
- **expense-discord-bot** — Node.js bot in [discord-bot/](discord-bot/) that watches `DISCORD_EXPENSE_CHANNEL_ID` and forwards uploaded receipt images to `N8N_WEBHOOK_URL`

The [workflows/](workflows/) folder is mounted at `/workflows` inside the n8n container. The bot will crash-loop until you finish step 6 and set `N8N_WEBHOOK_URL` — that's expected on first run.

## 4. Import the workflow

1. Open http://localhost:5678 and create the owner account on first launch.
2. **Workflows → Import from File** → select [workflows/expense_management_n8n_workflow_with_mongodb.json](workflows/expense_management_n8n_workflow_with_mongodb.json).

## 5. Configure n8n credentials

The imported workflow needs two credentials wired up inside n8n:

### Google Sheets OAuth2 API
1. In Google Cloud Console, create an OAuth 2.0 Client (type: Web application) and enable the **Google Sheets API**.
2. Add `http://localhost:5678/rest/oauth2-credential/callback` as an authorized redirect URI.
3. In n8n: **Credentials → New → Google Sheets OAuth2 API**, paste the client ID/secret, sign in with the Google account that owns the spreadsheet.
4. Assign the credential to both the `Sheets Append - Pending Review` and `Sheets Append - Approved` nodes.

### MongoDB
- **Credentials → New → MongoDB**
- Connection string: `mongodb://admin:<MONGO_ROOT_PASSWORD>@mongo:27017/expense_rpa?authSource=admin`
- (`mongo` resolves inside the Docker network — don't use `localhost` here.)
- Assign the credential to every `MongoDB Insert - ...` node.

The LLM and Discord nodes already read from environment variables — no n8n credential needed.

## 6. Activate and get the webhook URL

1. Toggle the workflow to **Active**.
2. Open the `Webhook - Discord Receipt Submission` node and copy the **Production URL**. It will look like:
   `http://localhost:5678/webhook/expense-submission`

## 7. Send a test submission

Your Discord bot (not included here) must `POST` JSON to that webhook:

```json
{
  "discordUser": "Paul Krus",
  "discordUserId": "123456789",
  "messageTimestamp": "2026-05-25T14:14:34.000Z",
  "submittedDate": "2026-05-25",
  "messageId": "discord-message-id",
  "channelId": "discord-channel-id",
  "imageBase64": "<base64-encoded-receipt-image>",
  "mimeType": "image/jpeg"
}
```

Quick smoke test with curl:

```powershell
curl -X POST http://localhost:5678/webhook/expense-submission `
  -H "Content-Type: application/json" `
  -d '{ "discordUser":"Test", "discordUserId":"1", "messageTimestamp":"2026-05-25T14:14:34.000Z", "submittedDate":"2026-05-25", "imageBase64":"<base64>", "mimeType":"image/jpeg" }'
```

You should see a new row in the Google Sheet, a message in the Discord channel, and a log document in the `workflow_logs` Mongo collection.

## Stopping and resetting

```powershell
docker compose down            # stop containers, keep data
docker compose down -v         # stop AND delete volumes (wipes n8n + Mongo data)
```

## Troubleshooting

- **Google Sheets append fails with 401/403** — re-authorize the Google Sheets OAuth2 credential, confirm the spreadsheet ID, and make sure the Google account has edit access to the sheet.
- **MongoDB connection refused** — make sure the credential host is `mongo` (the service name), not `localhost`.
- **LLM returns no usable response** — check `LLM_BASE_URL` (no trailing slash), `LLM_API_KEY`, and that `LLM_MODEL` is a vision-capable model the endpoint actually serves.
- **LLM returns text but no JSON** — some models ignore the "JSON only" instruction. Try a stronger model (`gpt-4o`, `claude-3-5-sonnet-latest`) or one that supports JSON mode.
- **Webhook 404** — the workflow must be Active; the test URL only works while the editor's "Listen for test event" is running.

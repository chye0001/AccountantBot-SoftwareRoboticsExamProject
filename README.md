# AccountantBot — Automated Expense Management RPA

An n8n-based RPA prototype that turns Discord-submitted receipt photos into structured expense rows in Excel (via Microsoft Graph), using Claude for OCR/extraction and MongoDB for workflow logging.

## How it works

1. A Discord bot forwards a receipt image (base64) to an n8n webhook.
2. n8n sends the image to Claude (Anthropic API), which returns structured JSON.
3. The workflow validates required fields, then appends a row to an Excel table on OneDrive.
4. Discord is notified of the outcome (Approved / Pending Review / Rejected).
5. Every step is logged to a MongoDB collection.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- An [Anthropic API key](https://console.anthropic.com/)
- A Discord webhook URL and an "accountant" role ID (for mentions)
- A Microsoft 365 account with OneDrive + an Excel workbook containing a table named `Expenses`
- An Azure AD app registration for Microsoft Graph OAuth2 (used by n8n to write to Excel)

## 1. Clone and configure

```powershell
git clone <this-repo>
cd AccountantBot-SoftwareRoboticsExamProject
copy .env.example .env
```

Edit [.env](.env) and fill in:

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `ANTHROPIC_MODEL` | Claude model (default `claude-3-5-sonnet-latest`) |
| `DISCORD_LOG_WEBHOOK_URL` | Discord channel webhook URL for status messages |
| `DISCORD_ACCOUNTANT_ROLE_ID` | Discord role ID to ping for review |
| `EXCEL_WORKBOOK_ITEM_ID` | OneDrive item ID of the Excel workbook |
| `EXCEL_EXPENSE_TABLE_NAME` | Excel table name (default `Expenses`) |
| `MONGO_ROOT_USERNAME` / `MONGO_ROOT_PASSWORD` | Mongo admin credentials |
| `MONGO_DATABASE` | Mongo database name (default `expense_rpa`) |
| `MONGO_LOG_COLLECTION` | Mongo collection for logs (default `workflow_logs`) |

## 2. Prepare the Excel workbook

Create a workbook in OneDrive with a table named `Expenses` (or match `EXCEL_EXPENSE_TABLE_NAME`). Columns must be in this exact order:

```
SubmittedDate | MessageTimestamp | DiscordUser | DiscordUserId | ReceiptId |
Merchant | ReceiptDate | Category | Currency | TotalAmount | VATAmount |
PaymentMethod | BusinessPurpose | Status | Details | Confidence | MessageId
```

Get the workbook's drive item ID (used for `EXCEL_WORKBOOK_ITEM_ID`) via Graph Explorer:
`GET https://graph.microsoft.com/v1.0/me/drive/root:/path/to/Expenses.xlsx`

## 3. Start the stack

```powershell
docker compose up -d
```

This launches:
- **n8n** at http://localhost:5678 (volume: `n8n_accountantbot_data`)
- **MongoDB** at `localhost:27017` (volume: `mongo_accountantbot_data`)

The [workflows/](workflows/) folder is mounted at `/workflows` inside the n8n container.

## 4. Import the workflow

1. Open http://localhost:5678 and create the owner account on first launch.
2. **Workflows → Import from File** → select [workflows/expense_management_n8n_workflow_with_mongodb.json](workflows/expense_management_n8n_workflow_with_mongodb.json).

## 5. Configure n8n credentials

The imported workflow needs two credentials wired up inside n8n:

### Microsoft OAuth2 API (for Excel)
- **Credentials → New → Microsoft OAuth2 API**
- Use a registered Azure AD app with the `Files.ReadWrite` (or `Files.ReadWrite.All`) delegated scope
- Authorize and assign the credential to both `Excel Append - Pending Review` and `Excel Append - Approved` nodes

### MongoDB
- **Credentials → New → MongoDB**
- Connection string: `mongodb://admin:<MONGO_ROOT_PASSWORD>@mongo:27017/expense_rpa?authSource=admin`
- (`mongo` resolves inside the Docker network — don't use `localhost` here.)
- Assign the credential to every `MongoDB Insert - ...` node

The Anthropic and Discord nodes already read from environment variables — no credential needed.

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

You should see a new row in the Excel table, a message in the Discord channel, and a log document in the `workflow_logs` Mongo collection.

## Stopping and resetting

```powershell
docker compose down            # stop containers, keep data
docker compose down -v         # stop AND delete volumes (wipes n8n + Mongo data)
```

## Troubleshooting

- **Excel append fails with 401/403** — re-authorize the Microsoft OAuth2 credential and confirm the workbook item ID is correct.
- **MongoDB connection refused** — make sure the credential host is `mongo` (the service name), not `localhost`.
- **Claude returns no usable response** — check `ANTHROPIC_API_KEY` and that the model name in `ANTHROPIC_MODEL` is current.
- **Webhook 404** — the workflow must be Active; the test URL only works while the editor's "Listen for test event" is running.

import { Client, GatewayIntentBits, Partials } from "discord.js";

const {
    DISCORD_BOT_TOKEN,
    DISCORD_EXPENSE_CHANNEL_ID,
    N8N_WEBHOOK_URL,
    N8N_MOCK_WEBHOOK_URL
} = process.env;

if (!DISCORD_BOT_TOKEN) {
    throw new Error("Missing DISCORD_BOT_TOKEN in .env");
}

if (!DISCORD_EXPENSE_CHANNEL_ID) {
    throw new Error("Missing DISCORD_EXPENSE_CHANNEL_ID in .env");
}

if (!N8N_WEBHOOK_URL) {
    throw new Error("Missing N8N_WEBHOOK_URL in .env");
}

// Mock webhook URL for TEST messages. Explicit env wins; otherwise derive from
// the real URL by suffixing the path with -mock (matches the mock workflow's path).
const mockWebhookUrl =
    N8N_MOCK_WEBHOOK_URL ||
    N8N_WEBHOOK_URL.replace("expense-submission", "expense-submission-mock");

const TEST_SCENARIOS = ["approved", "pending", "rejected", "unavailable", "sheetfail", "sheetfail-pending"];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

client.once("clientReady", () => {
    client.user.setPresence({
        activities: [{ name: "receipts", type: 2 }],
        status: "online"
    });

    console.log(`Expense bot logged in as ${client.user.tag}`);
    console.log(`Listening for receipts in channel ID: ${DISCORD_EXPENSE_CHANNEL_ID}`);
    console.log(`Forwarding receipt data to: ${N8N_WEBHOOK_URL}`);
    console.log(`Forwarding TEST messages to: ${mockWebhookUrl}`);
});


client.on("messageCreate", async (message) => {
    try {
        // Ignore bot messages
        if (message.author.bot) return;

        // Only listen to the expense channel
        if (message.channelId !== DISCORD_EXPENSE_CHANNEL_ID) return;

        // TEST mode: "TEST approved" / "TEST pending" / "TEST rejected" / "TEST unavailable" / "TEST sheetfail" / "TEST sheetfail-pending"
        // No image required — sends a no-image payload to the mock n8n webhook.
        const testMatch = message.content?.match(/^TEST\s+([\w-]+)/);
        if (testMatch) {
            const scenario = testMatch[1].toLowerCase();

            if (!TEST_SCENARIOS.includes(scenario)) {
                await message.reply(
                    `Unknown TEST scenario: \`${testMatch[1]}\`. Use one of: ${TEST_SCENARIOS.map((s) => `\`${s}\``).join(", ")}.`
                );
                return;
            }

            console.log(`TEST submission from ${message.author.username}: scenario=${scenario}`);

            const testPayload = {
                discordUser: message.author.username,
                discordUserId: message.author.id,
                messageTimestamp: message.createdAt.toISOString(),
                submittedDate: new Date().toISOString().slice(0, 10),
                messageId: message.id,
                channelId: message.channelId,
                imageBase64: "",
                mimeType: "image/jpeg",
                mockScenario: scenario,
                originalMessage: message.content
            };

            const mockResponse = await fetch(mockWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(testPayload)
            });

            if (!mockResponse.ok) {
                const errorText = await mockResponse.text();
                console.error("n8n mock webhook error:", errorText);
                await message.reply(
                    `Test submission was received, but the mock workflow failed to process it. ` +
                    `Check that the mock workflow is imported and Active at ${mockWebhookUrl}.`
                );
                return;
            }

            await message.react("🧪");
            console.log(`TEST forwarded to mock n8n. Message ID: ${message.id}, scenario: ${scenario}`);
            return;
        }

        const attachment = message.attachments.first();

        if (!attachment) {
            await message.reply(
                "Please attach a receipt image — or send `TEST approved` / `TEST pending` / `TEST rejected` / `TEST unavailable` / `TEST sheetfail` / `TEST sheetfail-pending` to simulate via the mock workflow."
            );
            return;
        }

        const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];

        const mimeType = attachment.contentType || "image/jpeg";

        if (!allowedMimeTypes.includes(mimeType)) {
            await message.reply("Please upload a valid receipt image: JPG, PNG, or WEBP.");
            return;
        }

        console.log(`Receipt received from ${message.author.username}: ${attachment.name}`);

        // Download the Discord attachment
        const imageResponse = await fetch(attachment.url);

        if (!imageResponse.ok) {
            console.error(`Could not download image. Status: ${imageResponse.status}`);
            await message.reply("Could not download the receipt image.");
            return;
        }

        // Convert image to base64 because the n8n workflow expects imageBase64
        const arrayBuffer = await imageResponse.arrayBuffer();
        const imageBase64 = Buffer.from(arrayBuffer).toString("base64");

        const payload = {
            discordUser: message.author.username,
            discordUserId: message.author.id,
            messageTimestamp: message.createdAt.toISOString(),
            submittedDate: new Date().toISOString().slice(0, 10),
            messageId: message.id,
            channelId: message.channelId,
            imageBase64,
            mimeType,
            originalMessage: message.content || "",
            attachmentName: attachment.name || "",
            attachmentUrl: attachment.url
        };

        const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!n8nResponse.ok) {
            const errorText = await n8nResponse.text();
            console.error("n8n webhook error:", errorText);
            await message.reply("The receipt was received, but n8n failed to process it.");
            return;
        }

        await message.react("📨");

        console.log(`Receipt forwarded to n8n successfully. Message ID: ${message.id}`);
    } catch (error) {
        console.error("Bot error:", error);

        try {
            await message.reply("Something went wrong while sending the receipt to n8n.");
        } catch {
            console.error("Could not send error reply to Discord.");
        }
    }
});

client.login(DISCORD_BOT_TOKEN);
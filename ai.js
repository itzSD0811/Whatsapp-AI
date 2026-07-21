const axios = require('axios');
const fs = require('fs');
const path = require('path');
const settings = require('./default_settings.json');

// Read the system prompt
const systemPromptPath = path.join(__dirname, 'system_prompt.txt');
let systemPrompt = '';
try {
    systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');
} catch (error) {
    console.error('Could not read system_prompt.txt', error);
}

// Ensure API key is set
const API_KEY = process.env.NVIDIA_API_KEY;
if (!API_KEY) {
    console.warn("WARNING: NVIDIA_API_KEY is not set in .env!");
}

async function getChatCompletion(userMessage, imageInfo = null, conversationHistory = []) {
    const invoke_url = settings.ai.invoke_url;
    
    // Construct the messages array
    const messages = [];
    if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
    }
    
    // Add history
    messages.push(...conversationHistory);

    // Add current user message
    let userContent = userMessage;
    if (imageInfo) {
        userContent = [
            { type: "text", text: userMessage || "Describe this image." },
            { 
                type: "image_url", 
                image_url: { 
                    url: `data:${imageInfo.mimeType};base64,${imageInfo.base64}` 
                } 
            }
        ];
    }

    messages.push({ role: "user", content: userContent });

    const payload = {
        messages: messages,
        model: settings.ai.model,
        chat_template_kwargs: {
            enable_thinking: true
        },
        max_tokens: settings.ai.max_tokens,
        stream: false, // We use false for simpler handling in WhatsApp
        temperature: settings.ai.temperature,
        top_p: settings.ai.top_p
    };

    const headers = {
        "Authorization": `Bearer ${API_KEY}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    try {
        const response = await axios.post(invoke_url, payload, { headers });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error connecting to NVIDIA API:", error.response ? error.response.data : error.message);
        throw error;
    }
}

module.exports = {
    getChatCompletion
};

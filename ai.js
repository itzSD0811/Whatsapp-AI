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

async function getChatCompletion(userMessage, imageInfo = null, conversationHistory = []) {
    const provider = settings.ai.llm_provider || 'NVIDIA';
    let apiKey, invoke_url, aiSettings;

    if (provider.toUpperCase() === 'OPENROUTER') {
        apiKey = process.env.OPENROUTER_API_KEY;
        aiSettings = settings.ai.openrouter;
        if (!apiKey) console.warn("WARNING: OPENROUTER_API_KEY is not set in .env!");
    } else {
        apiKey = process.env.NVIDIA_API_KEY;
        aiSettings = settings.ai.nvidia;
        if (!apiKey) console.warn("WARNING: NVIDIA_API_KEY is not set in .env!");
    }

    invoke_url = aiSettings.invoke_url;
    
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

    const payloadTemplate = {
        messages: messages,
        max_tokens: aiSettings.max_tokens,
        stream: false, // We use false for simpler handling in WhatsApp
        temperature: aiSettings.temperature,
        top_p: aiSettings.top_p
    };

    // NVIDIA requires chat_template_kwargs for thinking
    if (provider.toUpperCase() === 'NVIDIA') {
        payloadTemplate.chat_template_kwargs = {
            enable_thinking: true
        };
    }

    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    // OpenRouter specific headers (optional but good for rankings)
    if (provider.toUpperCase() === 'OPENROUTER') {
        headers["HTTP-Referer"] = "https://github.com/SethruDineth/GammaBot";
        headers["X-Title"] = "Gamma BOT WhatsApp";
    }

    try {
        // Support both "models" (array) and "model" (string) for backward compatibility
        const modelsList = aiSettings.models || [aiSettings.model];
        
        // Fire off all requests simultaneously
        const promises = modelsList.map(modelName => {
            const payload = { ...payloadTemplate, model: modelName };
            return axios.post(invoke_url, payload, { headers })
                .then(response => response.data.choices[0].message.content);
        });

        // Return the first successful response instantly
        return await Promise.any(promises);
    } catch (error) {
        // If ALL requests fail, Promise.any throws an AggregateError
        if (error.name === 'AggregateError') {
            console.error(`All models failed for ${provider} API. Errors:`, error.errors.map(e => e.response ? e.response.data : e.message));
        } else {
            console.error(`Error connecting to ${provider} API:`, error.response ? error.response.data : error.message);
        }
        throw error;
    }
}

module.exports = {
    getChatCompletion
};

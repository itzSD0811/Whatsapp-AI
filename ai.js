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
    let invoke_url, aiSettings;

    // Load available keys (Primary + Backups)
    const availableKeys = [
        process.env[`${provider.toUpperCase()}_API_KEY`],
        process.env[`${provider.toUpperCase()}_API_KEY_B1`],
        process.env[`${provider.toUpperCase()}_API_KEY_B2`]
    ].filter(Boolean); // removes undefined/empty

    if (availableKeys.length === 0) {
        console.warn(`WARNING: No API keys found for ${provider} in .env!`);
    }

    if (provider.toUpperCase() === 'OPENROUTER') {
        aiSettings = settings.ai.openrouter;
    } else if (provider.toUpperCase() === 'GOOGLE') {
        aiSettings = settings.ai.google;
    } else {
        aiSettings = settings.ai.nvidia;
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

    // Base headers without authorization (auth added dynamically)
    const baseHeaders = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    };

    // OpenRouter specific headers (optional but good for rankings)
    if (provider.toUpperCase() === 'OPENROUTER') {
        baseHeaders["HTTP-Referer"] = "https://github.com/SethruDineth/GammaBot";
        baseHeaders["X-Title"] = "Gamma BOT WhatsApp";
    }

    try {
        // Support both "models" (array) and "model" (string) for backward compatibility
        const modelsList = aiSettings.models || [aiSettings.model];
        
        // Fire off all requests simultaneously
        const promises = modelsList.map(async (modelName) => {
            const payload = { ...payloadTemplate, model: modelName };
            
            // Try each available key in sequence until one succeeds
            for (let i = 0; i < availableKeys.length; i++) {
                try {
                    const headers = { ...baseHeaders, "Authorization": `Bearer ${availableKeys[i]}` };
                    const response = await axios.post(invoke_url, payload, { headers });
                    return response.data.choices[0].message.content;
                } catch (error) {
                    const status = error.response ? error.response.status : null;
                    
                    // If rate limited (429) and we have more backup keys to try
                    if (status === 429 && i < availableKeys.length - 1) {
                        console.error(`[Rate Limit 429] Key ${i+1} failed for ${provider} model ${modelName}. Switching to backup key...`);
                        continue; // try the next key in the loop
                    }
                    
                    // If not a rate limit, or we are completely out of backup keys, throw the error
                    throw error;
                }
            }
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

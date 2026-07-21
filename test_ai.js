require('dotenv').config();
const ai = require('./ai');

async function test() {
    console.log("Testing NVIDIA AI connection...");
    try {
        const response = await ai.getChatCompletion("Hello! This is a test request. Are you receiving me?");
        console.log("-----------------------------------------");
        console.log("AI Response:");
        console.log(response);
        console.log("-----------------------------------------");
        console.log("Test successful!");
    } catch (error) {
        console.error("Test failed!", error);
    }
}

test();

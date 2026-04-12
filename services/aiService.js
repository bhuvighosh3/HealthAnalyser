const { GoogleGenAI } = require('@google/genai');

const genAI = new GoogleGenAI({ 
    vertexai: true, 
    project: process.env.GCP_PROJECT_ID || 'healthmonitor-493021', 
    location: process.env.GCP_LOCATION || 'us-central1' 
});

async function generateText(prompt) {
    const result = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
    });
    return result.text;
}

module.exports = {
    genAI,
    generateText
};

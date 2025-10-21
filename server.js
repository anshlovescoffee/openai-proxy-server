const express = require('express');
const axios = require('axios');
const fileUpload = require('express-fileupload');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max file size
}));

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

// Verify environment variables
if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable is not set');
    process.exit(1);
}

if (!API_SECRET) {
    console.error('ERROR: API_SECRET environment variable is not set');
    process.exit(1);
}

// Middleware to verify requests from your app
const verifyRequest = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('Missing or invalid Authorization header');
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (token !== API_SECRET) {
        console.log('Invalid API secret');
        return res.status(401).json({ error: 'Unauthorized: Invalid API secret' });
    }
    
    next();
};

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        hasOpenAIKey: !!OPENAI_API_KEY,
        hasAPISecret: !!API_SECRET
    });
});

// Chat completions endpoint
app.post('/api/chat/completions', verifyRequest, async (req, res) => {
    console.log('Received chat completion request');
    
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            req.body,
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 190000 // 190 seconds
            }
        );
        
        console.log('Successfully proxied chat request to OpenAI');
        res.json(response.data);
        
    } catch (error) {
        console.error('OpenAI API Error:', error.response?.data || error.message);
        
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { 
            error: { 
                message: error.message || 'Internal server error',
                type: 'proxy_error'
            } 
        };
        
        res.status(statusCode).json(errorData);
    }
});

// Whisper transcription endpoint
app.post('/api/audio/transcriptions', verifyRequest, async (req, res) => {
    console.log('Received audio transcription request');
    
    try {
        // Check if file was uploaded
        if (!req.files || !req.files.file) {
            return res.status(400).json({ 
                error: { message: 'No audio file provided' } 
            });
        }
        
        const FormData = require('form-data');
        const form = new FormData();
        
        // Add the audio file
        const audioFile = req.files.file;
        form.append('file', audioFile.data, {
            filename: audioFile.name,
            contentType: audioFile.mimetype
        });
        
        // Add model parameter
        form.append('model', req.body.model || 'whisper-1');
        
        const response = await axios.post(
            'https://api.openai.com/v1/audio/transcriptions',
            form,
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    ...form.getHeaders()
                },
                timeout: 190000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );
        
        console.log('Successfully transcribed audio via OpenAI');
        res.json(response.data);
        
    } catch (error) {
        console.error('Whisper API Error:', error.response?.data || error.message);
        
        const statusCode = error.response?.status || 500;
        const errorData = error.response?.data || { 
            error: { 
                message: error.message || 'Internal server error',
                type: 'proxy_error'
            } 
        };
        
        res.status(statusCode).json(errorData);
    }
});

// Catch-all for undefined routes
// Catch-all for undefined routes
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        message: 'The requested endpoint does not exist'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: { 
            message: 'Internal server error',
            type: 'server_error'
        } 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ OpenAI Proxy Server running on port ${PORT}`);
    console.log(`✅ OpenAI API Key: ${OPENAI_API_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`✅ API Secret: ${API_SECRET ? 'Set' : 'NOT SET'}`);
    console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    process.exit(0);
});
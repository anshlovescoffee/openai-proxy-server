const express = require('express');
const axios = require('axios');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const path = require('path');
const loggingMiddleware = require('./middleware/loggingMiddleware');
const logger = require('./logger');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max file size
}));

// Serve static files from public directory
app.use(express.static('public'));

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const API_SECRET = process.env.API_SECRET;
const PORT = process.env.PORT || 3000;

// Verify environment variables
if (!OPENAI_API_KEY) {
    console.error('WARNING: OPENAI_API_KEY environment variable is not set');
}

if (!ANTHROPIC_API_KEY) {
    console.error('WARNING: ANTHROPIC_API_KEY environment variable is not set');
}

if (!GOOGLE_API_KEY) {
    console.error('WARNING: GOOGLE_API_KEY environment variable is not set');
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
        hasAnthropicKey: !!ANTHROPIC_API_KEY,
        hasGoogleKey: !!GOOGLE_API_KEY,
        hasAPISecret: !!API_SECRET,
        loggingEnabled: true,
        supportedProviders: {
            openai: !!OPENAI_API_KEY,
            anthropic: !!ANTHROPIC_API_KEY,
            google: !!GOOGLE_API_KEY
        }
    });
});

// ============================================
// PUBLIC ANALYTICS ENDPOINTS (NO AUTH REQUIRED)
// These MUST be before app.use('/api', verifyRequest, loggingMiddleware)
// ============================================

// Get stats for a specific user
app.get('/api/analytics/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const stats = await logger.getUserStats(userId);
        
        if (!stats) {
            return res.status(404).json({
                error: 'User not found',
                message: 'No usage data found for this user'
            });
        }
        
        res.json(stats);
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            error: 'Failed to fetch user analytics',
            message: error.message
        });
    }
});

// Get stats for all users
app.get('/api/analytics/all', async (req, res) => {
    try {
        const stats = await logger.getAllUserStats();
        
        // Add summary totals
        const summary = {
            totalUsers: Object.keys(stats).length,
            totalRequests: 0,
            totalTokens: 0,
            totalCost: 0,
            users: stats
        };
        
        Object.values(stats).forEach(user => {
            summary.totalRequests += user.totalRequests;
            summary.totalTokens += user.totalTokens;
            summary.totalCost += user.totalCost;
        });
        
        res.json(summary);
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            error: 'Failed to fetch analytics',
            message: error.message
        });
    }
});

// Get recent activity (last N hours)
app.get('/api/analytics/recent', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const logs = await logger.getRecentLogs(hours);
        
        res.json({
            period: `Last ${hours} hours`,
            count: logs.length,
            logs: logs
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            error: 'Failed to fetch recent logs',
            message: error.message
        });
    }
});

// Get usage summary (aggregated stats)
app.get('/api/analytics/summary', async (req, res) => {
    try {
        const allStats = await logger.getAllUserStats();
        const recentLogs = await logger.getRecentLogs(24);
        
        // Calculate totals
        let totalUsers = 0;
        let totalRequests = 0;
        let totalTokens = 0;
        let totalCost = 0;
        let activeToday = 0;
        
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        
        Object.entries(allStats).forEach(([userId, stats]) => {
            totalUsers++;
            totalRequests += stats.totalRequests;
            totalTokens += stats.totalTokens;
            totalCost += stats.totalCost;
            
            // Check if user was active today
            if (stats.lastSeen && stats.lastSeen.startsWith(today)) {
                activeToday++;
            }
        });
        
        // Aggregate by model
        const modelBreakdown = {};
        Object.values(allStats).forEach(stats => {
            Object.entries(stats.modelCounts || {}).forEach(([model, count]) => {
                modelBreakdown[model] = (modelBreakdown[model] || 0) + count;
            });
        });
        
        res.json({
            overview: {
                totalUsers,
                activeToday,
                totalRequests,
                totalTokens,
                totalCost: parseFloat(totalCost.toFixed(4)),
                averageRequestsPerUser: totalUsers > 0 ? Math.round(totalRequests / totalUsers) : 0
            },
            last24Hours: {
                requests: recentLogs.length,
                uniqueUsers: new Set(recentLogs.map(log => log.userId)).size
            },
            modelBreakdown,
            timestamp: now.toISOString()
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({
            error: 'Failed to fetch summary',
            message: error.message
        });
    }
});

// ============================================
// PROTECTED API ENDPOINTS (REQUIRE AUTH)
// Apply logging middleware to API routes (AFTER analytics, so analytics are public)
// ============================================

app.use('/api', verifyRequest, loggingMiddleware);

// ============================================
// OPENAI ENDPOINTS
// ============================================

// Chat completions endpoint (OpenAI)
app.post('/api/chat/completions', async (req, res) => {
    console.log('Received chat completion request for OpenAI');
    
    if (!OPENAI_API_KEY) {
        return res.status(503).json({
            error: { message: 'OpenAI API not configured', type: 'configuration_error' }
        });
    }
    
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
app.post('/api/audio/transcriptions', async (req, res) => {
    console.log('Received audio transcription request');
    
    if (!OPENAI_API_KEY) {
        return res.status(503).json({
            error: { message: 'OpenAI API not configured', type: 'configuration_error' }
        });
    }
    
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

// ============================================
// ANTHROPIC (CLAUDE) ENDPOINTS
// ============================================

app.post('/api/anthropic/messages', async (req, res) => {
    console.log('Received chat completion request for Anthropic Claude');
    
    if (!ANTHROPIC_API_KEY) {
        return res.status(503).json({
            error: { message: 'Anthropic API not configured', type: 'configuration_error' }
        });
    }
    
    try {
        // Transform request to Anthropic format if needed
        const anthropicRequest = {
            model: req.body.model || 'claude-sonnet-4-20250514',
            max_tokens: req.body.max_tokens || 4096,
            messages: req.body.messages,
            system: req.body.system
        };
        
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            anthropicRequest,
            {
                headers: {
                    'x-api-key': ANTHROPIC_API_KEY,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                },
                timeout: 190000
            }
        );
        
        console.log('Successfully proxied chat request to Anthropic');
        
        // Transform response to match OpenAI format for consistency
        const transformedResponse = {
            id: response.data.id,
            object: 'chat.completion',
            created: Date.now(),
            model: response.data.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: response.data.content[0]?.text || ''
                },
                finish_reason: response.data.stop_reason === 'end_turn' ? 'stop' : response.data.stop_reason
            }],
            usage: {
                prompt_tokens: response.data.usage?.input_tokens || 0,
                completion_tokens: response.data.usage?.output_tokens || 0,
                total_tokens: (response.data.usage?.input_tokens || 0) + (response.data.usage?.output_tokens || 0)
            }
        };
        
        res.json(transformedResponse);
        
    } catch (error) {
        console.error('Anthropic API Error:', error.response?.data || error.message);
        
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

// ============================================
// GOOGLE (GEMINI) ENDPOINTS
// ============================================

app.post('/api/google/generateContent', async (req, res) => {
    console.log('Received chat completion request for Google Gemini');
    
    if (!GOOGLE_API_KEY) {
        return res.status(503).json({
            error: { message: 'Google API not configured', type: 'configuration_error' }
        });
    }
    
    try {
        const model = req.body.model || 'gemini-2.5-pro';
        
        // Transform request to Gemini format
        const geminiRequest = {
            contents: req.body.contents || transformMessagesToGeminiFormat(req.body.messages),
            generationConfig: req.body.generationConfig || {
                temperature: 0.7,
                maxOutputTokens: 4096
            },
            safetySettings: req.body.safetySettings || [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        };
        
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`,
            geminiRequest,
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 190000
            }
        );
        
        console.log('Successfully proxied chat request to Google Gemini');
        
        // Transform response to match OpenAI format for consistency
        const geminiContent = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const transformedResponse = {
            id: `gemini-${Date.now()}`,
            object: 'chat.completion',
            created: Date.now(),
            model: model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: geminiContent
                },
                finish_reason: response.data.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : 'length'
            }],
            usage: {
                prompt_tokens: response.data.usageMetadata?.promptTokenCount || 0,
                completion_tokens: response.data.usageMetadata?.candidatesTokenCount || 0,
                total_tokens: response.data.usageMetadata?.totalTokenCount || 0
            }
        };
        
        res.json(transformedResponse);
        
    } catch (error) {
        console.error('Google Gemini API Error:', error.response?.data || error.message);
        
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

// Helper function to transform OpenAI-style messages to Gemini format
function transformMessagesToGeminiFormat(messages) {
    if (!messages) return [];
    
    const contents = [];
    let systemPrompt = '';
    
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemPrompt = msg.content;
            continue;
        }
        
        const role = msg.role === 'assistant' ? 'model' : 'user';
        
        // Handle content that may be string or array (for images)
        let parts = [];
        
        if (typeof msg.content === 'string') {
            // Prepend system prompt to first user message
            if (role === 'user' && systemPrompt && contents.length === 0) {
                parts.push({ text: `${systemPrompt}\n\n${msg.content}` });
                systemPrompt = '';
            } else {
                parts.push({ text: msg.content });
            }
        } else if (Array.isArray(msg.content)) {
            // Handle multimodal content (text + images)
            for (const item of msg.content) {
                if (item.type === 'text') {
                    if (role === 'user' && systemPrompt && contents.length === 0) {
                        parts.push({ text: `${systemPrompt}\n\n${item.text}` });
                        systemPrompt = '';
                    } else {
                        parts.push({ text: item.text });
                    }
                } else if (item.type === 'image_url') {
                    // Extract base64 data from data URL
                    const imageUrl = item.image_url.url;
                    if (imageUrl.startsWith('data:')) {
                        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                        if (matches) {
                            parts.push({
                                inline_data: {
                                    mime_type: matches[1],
                                    data: matches[2]
                                }
                            });
                        }
                    }
                }
            }
        }
        
        contents.push({ role, parts });
    }
    
    return contents;
}

// ============================================
// UNIFIED MULTI-PROVIDER ENDPOINT
// ============================================

app.post('/api/unified/chat', async (req, res) => {
    const provider = req.body.provider || 'openai';
    const model = req.body.model;
    
    console.log(`Received unified chat request for provider: ${provider}, model: ${model}`);
    
    // Route to appropriate provider
    switch (provider.toLowerCase()) {
        case 'openai':
            req.url = '/api/chat/completions';
            return app._router.handle(req, res, () => {});
            
        case 'anthropic':
        case 'claude':
            req.url = '/api/anthropic/messages';
            return app._router.handle(req, res, () => {});
            
        case 'google':
        case 'gemini':
            req.url = '/api/google/generateContent';
            return app._router.handle(req, res, () => {});
            
        default:
            return res.status(400).json({
                error: {
                    message: `Unknown provider: ${provider}`,
                    type: 'invalid_request'
                }
            });
    }
});

// ============================================
// FILE UPLOAD ENDPOINT (for document context)
// ============================================

app.post('/api/files/upload', async (req, res) => {
    console.log('Received file upload request');
    
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({
                error: { message: 'No files were uploaded' }
            });
        }
        
        const uploadedFiles = [];
        const files = Array.isArray(req.files.files) ? req.files.files : [req.files.files];
        
        // Process each file
        for (const file of files) {
            // Check file size (max 10MB per file)
            if (file.size > 10 * 1024 * 1024) {
                return res.status(400).json({
                    error: { message: `File ${file.name} exceeds 10MB limit` }
                });
            }
            
            // Extract text content based on file type
            let textContent = '';
            const mimeType = file.mimetype;
            
            if (mimeType === 'application/pdf') {
                // For PDF, we'll just send the base64 data
                // The AI models can handle PDFs directly
                textContent = null;
            } else if (mimeType.startsWith('text/') || 
                       mimeType === 'application/json' ||
                       mimeType === 'application/xml') {
                textContent = file.data.toString('utf8');
            }
            
            uploadedFiles.push({
                name: file.name,
                mimeType: mimeType,
                size: file.size,
                base64: file.data.toString('base64'),
                textContent: textContent
            });
        }
        
        res.json({
            success: true,
            files: uploadedFiles,
            count: uploadedFiles.length
        });
        
    } catch (error) {
        console.error('File upload error:', error);
        res.status(500).json({
            error: {
                message: error.message || 'Failed to process uploaded files',
                type: 'upload_error'
            }
        });
    }
});

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
    console.log(`✅ Multi-Provider AI Proxy Server running on port ${PORT}`);
    console.log(`✅ OpenAI API Key: ${OPENAI_API_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`✅ Anthropic API Key: ${ANTHROPIC_API_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`✅ Google API Key: ${GOOGLE_API_KEY ? 'Set' : 'NOT SET'}`);
    console.log(`✅ API Secret: ${API_SECRET ? 'Set' : 'NOT SET'}`);
    console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📊 Usage logging: ENABLED`);
    console.log(`🌐 Dashboard available at /dashboard`);
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
// middleware/loggingMiddleware.js
const logger = require('../logger');

async function loggingMiddleware(req, res, next) {
    const userId = req.headers['x-user-id'] || 'unknown';
    const endpoint = req.path;
    const model = req.body?.model;
    
    console.log(`📝 Request from user: ${userId.substring(0, 12)}..., endpoint: ${endpoint}, model: ${model}`);
    
    // Capture the original json and send functions
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    
    // Override res.json
    res.json = function(data) {
        logResponse(data);
        return originalJson(data);
    };
    
    // Override res.send
    res.send = function(data) {
        try {
            const responseData = typeof data === 'string' ? JSON.parse(data) : data;
            logResponse(responseData);
        } catch (error) {
            // If not JSON, skip logging
        }
        return originalSend(data);
    };
    
    function logResponse(responseData) {
        logger.logRequest(userId, endpoint, model, req.body, responseData)
            .catch(err => console.error('❌ Logging error:', err));
    }
    
    next();
}

module.exports = loggingMiddleware;

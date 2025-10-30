// logger.js
const fs = require('fs').promises;
const path = require('path');

class UsageLogger {
    constructor() {
        // Use /tmp on Railway for now (or add volume later)
        this.logsDir = process.env.LOGS_DIR || path.join('/tmp', 'logs');
        this.ensureLogsDirectory();
        console.log(`📁 Logs directory: ${this.logsDir}`);
    }
    
    async ensureLogsDirectory() {
        try {
            await fs.mkdir(this.logsDir, { recursive: true });
            console.log('✅ Logs directory ready');
        } catch (error) {
            console.error('❌ Failed to create logs directory:', error);
        }
    }
    
    async logRequest(userId, endpoint, model, requestData, responseData) {
        const timestamp = new Date().toISOString();
        const date = timestamp.split('T')[0];
        
        const logEntry = {
            timestamp,
            userId,
            endpoint,
            model,
            tokens: {
                prompt: responseData?.usage?.prompt_tokens || 0,
                completion: responseData?.usage?.completion_tokens || 0,
                total: responseData?.usage?.total_tokens || 0
            },
            cost: this.calculateCost(model, responseData?.usage),
            success: !!responseData && !responseData.error,
            error: responseData?.error?.message || null
        };
        
        // Log to console for Railway logs (visible in dashboard)
        console.log('📊 Usage:', JSON.stringify(logEntry));
        
        // Daily log file
        const logFile = path.join(this.logsDir, `usage-${date}.jsonl`);
        
        try {
            await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.error('❌ Failed to write log file:', error);
        }
        
        // Update user summary
        await this.updateUserSummary(userId, logEntry);
    }
    
    calculateCost(model, usage) {
        if (!usage) return 0;
        
        // Approximate costs per 1M tokens (update with actual pricing)
        const pricing = {
            'gpt-4': { input: 30, output: 60 },
            'gpt-4o': { input: 5, output: 15 },
            'gpt-4o-mini': { input: 0.15, output: 0.6 },
            'gpt-5': { input: 10, output: 30 },
            'o1-preview': { input: 15, output: 60 },
            'o1-mini': { input: 3, output: 12 },
            'gpt-3.5-turbo': { input: 0.5, output: 1.5 }
        };
        
        const modelPricing = pricing[model] || pricing['gpt-4o'];
        const inputCost = (usage.prompt_tokens / 1000000) * modelPricing.input;
        const outputCost = (usage.completion_tokens / 1000000) * modelPricing.output;
        
        return inputCost + outputCost;
    }
    
    async updateUserSummary(userId, logEntry) {
        const summaryFile = path.join(this.logsDir, 'user_summaries.json');
        
        try {
            let summaries = {};
            
            try {
                const data = await fs.readFile(summaryFile, 'utf8');
                summaries = JSON.parse(data);
            } catch (error) {
                // File doesn't exist yet
            }
            
            if (!summaries[userId]) {
                summaries[userId] = {
                    firstSeen: logEntry.timestamp,
                    totalRequests: 0,
                    totalTokens: 0,
                    totalCost: 0,
                    endpointCounts: {},
                    modelCounts: {}
                };
            }
            
            const userSummary = summaries[userId];
            userSummary.totalRequests++;
            userSummary.totalTokens += logEntry.tokens.total;
            userSummary.totalCost += logEntry.cost;
            userSummary.lastSeen = logEntry.timestamp;
            
            userSummary.endpointCounts[logEntry.endpoint] =
                (userSummary.endpointCounts[logEntry.endpoint] || 0) + 1;
            
            userSummary.modelCounts[logEntry.model] =
                (userSummary.modelCounts[logEntry.model] || 0) + 1;
            
            await fs.writeFile(summaryFile, JSON.stringify(summaries, null, 2));
        } catch (error) {
            console.error('❌ Failed to update user summary:', error);
        }
    }
    
    async getUserStats(userId) {
        const summaryFile = path.join(this.logsDir, 'user_summaries.json');
        
        try {
            const data = await fs.readFile(summaryFile, 'utf8');
            const summaries = JSON.parse(data);
            return summaries[userId] || null;
        } catch (error) {
            return null;
        }
    }
    
    async getAllUserStats() {
        const summaryFile = path.join(this.logsDir, 'user_summaries.json');
        
        try {
            const data = await fs.readFile(summaryFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return {};
        }
    }
    
    async getRecentLogs(hours = 24) {
        const logs = [];
        const now = new Date();
        
        // Check last few days of log files
        for (let i = 0; i < 3; i++) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            const logFile = path.join(this.logsDir, `usage-${dateStr}.jsonl`);
            
            try {
                const data = await fs.readFile(logFile, 'utf8');
                const lines = data.trim().split('\n');
                
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        const entryTime = new Date(entry.timestamp);
                        const hoursDiff = (now - entryTime) / (1000 * 60 * 60);
                        
                        if (hoursDiff <= hours) {
                            logs.push(entry);
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            } catch (error) {
                // File doesn't exist, skip
            }
        }
        
        return logs.sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
        );
    }
}

module.exports = new UsageLogger();

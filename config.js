```javascript
module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || '',
  CHAT_ID: process.env.CHAT_ID || '',
  USE_TELEGRAM: process.env.USE_TELEGRAM === 'true' || false,
  PREDICTION_TOP_N: parseInt(process.env.PREDICTION_TOP_N, 10) || 5,
  ALERT_10_PERCENT_THRESHOLD: parseInt(process.env.ALERT_10_PERCENT_THRESHOLD, 10) || 10,
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL, 10) || 120000 // 2 minutes
};
```

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { 
  configure, 
  checkPNRStatus, 
  getTrainInfo, 
  trackTrain, 
  searchTrainBetweenStations 
} from 'railkit';

dotenv.config();

if (process.env.RAILKIT_API_KEY) {
  configure(process.env.RAILKIT_API_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

// 1. Health check & keep-alive endpoint for UptimeRobot
app.get('/', (req, res) => {
  res.json({
    status: 'SeatSaathi PNR & Train Engine Active',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 2. Comprehensive PNR lookup
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;
  try {
    const result = await checkPNRStatus(pnr);
    if (!result || !result.success) {
      return res.status(404).json({
        success: false,
        message: result?.message || 'PNR details not found on IRCTC servers'
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to query PNR status'
    });
  }
});

// 3. Complete Train Route, Schedule & Station Stoppages
app.get('/api/train/:trainNo', async (req, res) => {
  const { trainNo } = req.params;
  try {
    const result = await getTrainInfo(trainNo);
    if (!result || !result.success) {
      return res.status(404).json({
        success: false,
        message: result?.message || `Train ${trainNo} not found`
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch train information'
    });
  }
});

// 4. Live Running Status (Train No + Date in DD-MM-YYYY)
app.get('/api/train/:trainNo/live/:date', async (req, res) => {
  const { trainNo, date } = req.params;
  try {
    const result = await trackTrain(trainNo, date);
    if (!result || !result.success) {
      return res.status(404).json({
        success: false,
        message: result?.message || 'Live tracking details unavailable'
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to track train movement'
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`⚡ SeatSaathi PNR & Train Service running on port ${PORT}`);
});

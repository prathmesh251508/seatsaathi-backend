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
// Checks RapidAPI if configured; otherwise queries railkit engine
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;
  const apiKey = process.env.RAPIDAPI_KEY;
  const apiHost = process.env.RAPIDAPI_HOST || 'irctc1.p.rapidapi.com';

  // Path A: RapidAPI if environment key is provided in Render
  if (apiKey) {
    try {
      const response = await fetch(`https://${apiHost}/api/v3/getPNRStatus?pnrNumber=${pnr}`, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': apiHost
        }
      });
      const result = await response.json();

      if (result && (result.status === true || result.success) && result.data) {
        const d = result.data;
        return res.json({
          success: true,
          data: {
            pnr: pnr,
            trainNumber: d.trainNumber || d.train_number,
            trainName: d.trainName || d.train_name,
            journeyDate: d.dateOfJourney || d.doj,
            coachClass: d.journeyClass || d.class,
            boardingStation: d.boardingStationCode || d.source,
            destinationStation: d.reservationUptoCode || d.destination,
            passengers: (d.passengerList || []).map((p, idx) => ({
              name: `Passenger ${idx + 1}`,
              coach: p.bookingCoachId || p.currentCoachId || "B1",
              seat: p.bookingBerthNo || p.currentBerthNo || "1",
              berth: p.bookingBerthCode || p.currentBerthCode || "Middle Berth"
            }))
          }
        });
      }
    } catch (rapidErr) {
      console.warn("RapidAPI lookup failed, checking railkit engine:", rapidErr.message);
    }
  }

  // Path B: Railkit direct lookup
  try {
    const result = await checkPNRStatus(pnr);
    if (!result || !result.success) {
      return res.status(404).json({
        success: false,
        message: result?.message || 'PNR details not found on IRCTC servers'
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to query PNR status'
    });
  }
});

// 3. Train Route, Schedule & Intermediate Stations
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

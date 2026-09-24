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
  const apiHost = process.env.RAPIDAPI_HOST || 'pnr-status-indian-railway.p.rapidapi.com';

  console.log(`[PNR] Querying details for ${pnr}...`);

  // Path A: RapidAPI if environment key is provided in Render
  if (apiKey) {
    try {
      // dev2919 endpoint uses /{PNR}
      const response = await fetch(`https://${apiHost}/${pnr}`, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': apiHost
        }
      });
      const result = await response.json();

      if (result && !result.message && (result.data || result.train_name || result.train_number || result.TrainNo)) {
        const d = result.data || result;
        const passList = d.passenger_list || d.passengerList || d.passengers || [];

        return res.json({
          success: true,
          data: {
            pnr: pnr,
            trainNumber: d.train_number || d.trainNumber || d.TrainNo,
            trainName: d.train_name || d.trainName || d.TrainName,
            journeyDate: d.doj || d.dateOfJourney || d.journey_date,
            coachClass: d.class || d.journeyClass || d.booking_class,
            boardingStation: d.boarding_station_code || d.source || d.boardingStationCode,
            destinationStation: d.destination_station_code || d.destination || d.reservationUptoCode,
            passengers: passList.length > 0 ? passList.map((p, idx) => ({
              name: `Passenger ${idx + 1}`,
              coach: p.coach || p.bookingCoachId || p.currentCoachId || "B1",
              seat: p.seat || p.berth_no || p.bookingBerthNo || p.currentBerthNo || "1",
              berth: p.berth || p.berth_type || p.bookingBerthCode || "Middle Berth"
            })) : [
              { name: "Passenger 1", coach: "B1", seat: "21", berth: "Lower Berth" }
            ]
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

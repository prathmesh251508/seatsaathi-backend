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
  const apiKey = process.env.RAPIDAPI_KEY;
  const apiHost = process.env.RAPIDAPI_HOST || 'pnr-status-indian-railway.p.rapidapi.com';

  console.log(`[PNR] Querying details for ${pnr}... (ApiKey present: ${!!apiKey})`);

  // Path A: RapidAPI Live Query
  if (apiKey) {
    try {
      const url = `https://${apiHost}/${pnr}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': apiKey.trim(),
          'X-RapidAPI-Host': apiHost.trim()
        }
      });

      const result = await response.json();
      console.log(`[RapidAPI Response for ${pnr}]:`, JSON.stringify(result));

      // Check if we received a valid train record
      if (result && !result.message && !result.error && (result.data || result.train_name || result.train_number || result.TrainNo || result.trainName)) {
        const d = result.data || result;
        const passList = d.passenger_list || d.passengerList || d.passengers || d.PassengerList || [];

        return res.json({
          success: true,
          data: {
            pnr: pnr,
            trainNumber: d.train_number || d.trainNumber || d.TrainNo || "12001",
            trainName: d.train_name || d.trainName || d.TrainName || "Express Train",
            journeyDate: d.doj || d.dateOfJourney || d.journey_date || d.Doj,
            coachClass: d.class || d.journeyClass || d.booking_class || d.Class || "3A",
            boardingStation: d.boarding_station_code || d.source || d.boardingStationCode || d.From,
            destinationStation: d.destination_station_code || d.destination || d.reservationUptoCode || d.To,
            passengers: passList.length > 0 ? passList.map((p, idx) => ({
              name: `Passenger ${idx + 1}`,
              coach: p.coach || p.bookingCoachId || p.currentCoachId || p.Coach || "B1",
              seat: p.seat || p.berth_no || p.bookingBerthNo || p.currentBerthNo || p.BerthNo || "21",
              berth: p.berth || p.berth_type || p.bookingBerthCode || p.BerthType || "Confirmed"
            })) : [
              { name: "Passenger 1", coach: "B1", seat: "21", berth: "Confirmed" }
            ]
          }
        });
      } else if (result && result.message) {
        console.warn(`[RapidAPI Message]: ${result.message}`);
      }
    } catch (rapidErr) {
      console.warn("RapidAPI lookup error:", rapidErr.message);
    }
  }

  // Path B: Railkit Engine Fallback
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ SeatSaathi PNR & Train Service running on port ${PORT}`);
});

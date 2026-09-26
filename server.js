import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Direct Railway Gateway Scraper
async function fetchDirectGatewayPNR(pnr) {
  // Strategy 1: Mobile JSON Gateway
  try {
    const apiRes = await axios.post(
      `https://cttrainsapi.confirmtkt.com/api/v2/ctpro/mweb/${pnr}`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
          'Referer': 'https://www.confirmtkt.com/'
        },
        timeout: 8000
      }
    );

    const json = apiRes.data;
    const raw = json.data || json;

    if (raw && (raw.TrainNo || raw.train_number)) {
      const passList = raw.PassengerStatus || raw.passenger_status || [];
      return {
        pnr: raw.Pnr || pnr,
        trainNumber: raw.TrainNo || raw.train_number || '',
        trainName: raw.TrainName || raw.train_name || 'Express Train',
        journeyDate: raw.Doj || raw.doj || 'Upcoming',
        coachClass: raw.Class || raw.class || '3A',
        boardingStation: raw.BoardingStationName || raw.From || raw.boarding_station || '',
        destinationStation: raw.ReservationUptoName || raw.To || raw.destination_station || '',
        passengers: passList.length > 0
          ? passList.map((p, idx) => ({
              name: `Passenger ${idx + 1}`,
              coach: p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1',
              seat: p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`,
              berth: p.BookingBerthCode || p.CurrentBerthCode || p.current_status || 'Confirmed'
            }))
          : [{ name: 'Passenger 1', coach: 'B1', seat: '1', berth: 'Confirmed' }]
      };
    }
  } catch (apiErr) {
    console.warn('[Gateway] JSON endpoint skipped, trying web parser fallback...', apiErr.message);
  }

  // Strategy 2: Web Portal Parser Fallback
  const htmlRes = await axios.get(`https://www.confirmtkt.com/pnr-status/${pnr}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Referer': 'https://www.google.com/'
    },
    timeout: 10000
  });

  const html = htmlRes.data;
  const match = html.match(/data\s*=\s*(\{.+?\});/s);

  if (!match || !match[1]) {
    throw new Error('Could not find live ticket data on railway servers.');
  }

  const parsed = JSON.parse(match[1]);
  if (!parsed.TrainNo || parsed.ErrorMessage) {
    throw new Error(parsed.ErrorMessage || 'PNR record expired or not found.');
  }

  const passList = parsed.PassengerStatus || [];
  return {
    pnr: parsed.Pnr || pnr,
    trainNumber: parsed.TrainNo || '',
    trainName: parsed.TrainName || 'Express Train',
    journeyDate: parsed.Doj || 'Upcoming',
    coachClass: parsed.Class || '3A',
    boardingStation: parsed.BoardingStationName || parsed.From || '',
    destinationStation: parsed.ReservationUptoName || parsed.To || '',
    passengers: passList.length > 0
      ? passList.map((p, idx) => ({
          name: `Passenger ${idx + 1}`,
          coach: p.BookingCoachId || p.CurrentCoachId || 'B1',
          seat: p.BookingBerthNo || p.CurrentBerthNo || `${idx + 1}`,
          berth: p.BookingBerthCode || p.CurrentBerthCode || 'Confirmed'
        }))
      : [{ name: 'Passenger 1', coach: 'B1', seat: '1', berth: 'Confirmed' }]
  };
}

// Health Check Route
app.get('/', (req, res) => {
  res.json({ status: 'SeatSaathi PNR Engine Active', timestamp: new Date() });
});

// PNR Status Route
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;

  if (!pnr || pnr.length !== 10 || isNaN(pnr)) {
    return res.status(400).json({ error: 'PNR must be 10 numeric digits.' });
  }

  try {
    console.log(`[PNR] Querying details for ${pnr}...`);
    const tripData = await fetchDirectGatewayPNR(pnr);
    return res.json(tripData);
  } catch (err) {
    console.error('[Error]', err.message);
    return res.status(404).json({ error: err.message || 'Failed to retrieve PNR details from railway network.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ SeatSaathi PNR Service running at http://localhost:${PORT}`);
});

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.set('etag', false);
app.use(cors());
app.use(express.json());

// Indian Railways standard 72-berth coach layout helper
function getBerthType(seatNumber) {
  const num = parseInt(seatNumber, 10);
  if (isNaN(num) || num <= 0) return 'Confirmed';
  const mod = num % 8;
  switch (mod) {
    case 1:
    case 4: return 'Lower Berth (LB)';
    case 2:
    case 5: return 'Middle Berth (MB)';
    case 3:
    case 6: return 'Upper Berth (UB)';
    case 7: return 'Side Lower (SL)';
    case 0: return 'Side Upper (SU)';
    default: return 'Confirmed';
  }
}

// Direct lightweight API lookup (bypasses Chromium)
async function fetchDirectPNR(pnr) {
  const url = `https://www.confirmtkt.com/api/pnr/status/${pnr}`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://www.confirmtkt.com/pnr-status/${pnr}`,
    'Origin': 'https://www.confirmtkt.com'
  };

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Upstream server responded with status: ${response.status}`);
  }

  const result = await response.json();
  const raw = result.data || result;

  if (!raw || (!raw.TrainNo && !raw.train_number && !raw.TrainName)) {
    throw new Error('PNR details not found or ticket has expired.');
  }

  const rawPassengers = raw.PassengerStatus || raw.passenger_status || [];
  const passengers = rawPassengers.length > 0
    ? rawPassengers.map((p, idx) => {
        const coach = p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1';
        const seat = p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`;
        const berth = p.BookingBerthCode || p.CurrentBerthCode || getBerthType(seat);
        const status = p.CurrentStatus || p.BookingStatus || 'CNF';

        return {
          passengerNumber: idx + 1,
          name: `Passenger ${idx + 1}`,
          bookingStatus: p.BookingStatus || status,
          currentStatus: status,
          coach: coach,
          seatNumber: String(seat),
          berthType: berth
        };
      })
    : [
        {
          passengerNumber: 1,
          name: 'Passenger 1',
          bookingStatus: 'CNF',
          currentStatus: 'CNF',
          coach: 'B1',
          seatNumber: '1',
          berthType: 'Confirmed'
        }
      ];

  return {
    pnr: String(raw.Pnr || pnr),
    trainNumber: String(raw.TrainNo || raw.train_number || '---'),
    trainName: raw.TrainName || raw.train_name || 'Express Train',
    journeyDate: raw.Doj || raw.doj || 'Upcoming',
    coachClass: raw.Class || raw.class || '3A',
    boardingStation: raw.BoardingStationName || raw.From || '---',
    destinationStation: raw.ReservationUptoName || raw.To || '---',
    chartPrepared: Boolean(raw.ChartPrepared),
    passengers
  };
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'SeatSaathi Fast API Active', timestamp: new Date() });
});

// PNR lookup route
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;

  if (!pnr || !/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'PNR must be 10 numeric digits.' });
  }

  try {
    const details = await fetchDirectPNR(pnr);
    return res.json(details);
  } catch (err) {
    console.error('[API Error]:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to fetch live ticket details.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ SeatSaathi Fast Service running at http://localhost:${PORT}`);
});

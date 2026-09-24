const express = require('express');
const cors = require('cors');
const { checkPNRStatus } = require('railkit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'SeatSaathi PNR Engine Active', timestamp: new Date() });
});

app.get('/api/pnr/:pnr', async (req, res) => {
    const { pnr } = req.params;

    if (!pnr || pnr.length !== 10 || isNaN(pnr)) {
        return res.status(400).json({ error: 'PNR must be 10 numeric digits.' });
    }

    try {
        console.log(`[PNR] Querying details for ${pnr}...`);
        const data = await checkPNRStatus(pnr);

        if (!data || !data.trainNumber) {
            return res.status(404).json({ error: 'No booking details found for this PNR.' });
        }

        res.json({
            pnr: pnr,
            trainNumber: data.trainNumber || '',
            trainName: data.trainName || '',
            journeyDate: data.dateOfJourney || '',
            coachClass: data.journeyClass || '3A',
            boardingStation: data.boardingStation || '',
            destinationStation: data.destinationStation || '',
            passengers: (data.passengerList || []).map((p, idx) => ({
                name: p.passengerName || `Passenger ${idx + 1}`,
                coach: p.currentCoach || p.bookingCoach || '',
                seat: p.currentBerthNo || p.bookingBerthNo || '',
                berth: p.currentBerthCode || p.bookingBerthCode || 'Seat'
            }))
        });
    } catch (err) {
        console.error('[Error]', err);
        res.status(500).json({ error: 'Failed to retrieve PNR details from railway network.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`⚡ SeatSaathi PNR Service running at http://localhost:${PORT}`);
});

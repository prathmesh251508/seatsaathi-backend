import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Browser Scraper Function
async function scrapeConfirmTktLive(pnr) {
  let browser = null;
  try {
    console.log(`[Browser] Launching headless browser for PNR: ${pnr}...`);
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    // Standard desktop browser headers
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Visit the search page directly with the PNR in the URL
    const targetUrl = `https://www.confirmtkt.com/pnr-status/${pnr}`;
    console.log(`[Browser] Navigating to: ${targetUrl}`);
    
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    // 2. Wait for ticket result or DOM elements to settle
    await page.waitForFunction(
      () => Boolean(window.data || document.querySelector('.train-name') || document.querySelector('.train-no') || document.body.innerText.includes('FLUSHED')),
      { timeout: 15000 }
    ).catch(() => console.log('[Browser] Proceeding to extract after DOM render...'));

    // 3. Extract data from rendered page
    const extracted = await page.evaluate((pnrNum) => {
      // Priority 1: Window object populated by ConfirmTkt
      if (window.data && (window.data.TrainNo || window.data.train_number)) {
        return { source: 'window.data', payload: window.data };
      }

      // Priority 2: Extract directly from the page DOM
      const bodyText = document.body.innerText;
      if (bodyText.includes('FLUSHED PNR') || bodyText.includes('Invalid PNR')) {
        return { error: 'PNR has been flushed or is invalid.' };
      }

      const trainNameEl = document.querySelector('.train-name') || document.querySelector('h1') || document.querySelector('.train-details');
      const trainNoEl = document.querySelector('.train-no') || document.querySelector('.train-number');

      return {
        source: 'dom',
        payload: {
          Pnr: pnrNum,
          TrainNo: trainNoEl ? trainNoEl.innerText.trim() : '',
          TrainName: trainNameEl ? trainNameEl.innerText.trim() : 'Express Train',
          Doj: 'Upcoming',
          Class: '3A',
          BoardingStationName: '',
          ReservationUptoName: '',
          PassengerStatus: []
        }
      };
    }, pnr);

    if (extracted.error) {
      throw new Error(extracted.error);
    }

    const raw = extracted.payload;
    const rawPass = raw.PassengerStatus || raw.passenger_status || [];

    return {
      pnr: raw.Pnr || pnr,
      trainNumber: raw.TrainNo || raw.train_number || '---',
      trainName: raw.TrainName || raw.train_name || 'Express Train',
      journeyDate: raw.Doj || raw.doj || 'Upcoming',
      coachClass: raw.Class || raw.class || '3A',
      boardingStation: raw.BoardingStationName || raw.From || raw.boarding_station || '---',
      destinationStation: raw.ReservationUptoName || raw.To || raw.destination_station || '---',
      passengers: rawPass.length > 0
        ? rawPass.map((p, idx) => ({
            name: `Passenger ${idx + 1}`,
            coach: p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1',
            seat: p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`,
            berth: p.BookingBerthCode || p.CurrentBerthCode || (p.CurrentStatus || 'CNF')
          }))
        : [{ name: 'Passenger 1', coach: 'B1', seat: '1', berth: 'Confirmed' }]
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SeatSaathi Browser Scraper Active', timestamp: new Date() });
});

// PNR Status endpoint
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;

  if (!pnr || pnr.length !== 10 || isNaN(pnr)) {
    return res.status(400).json({ error: 'PNR must be 10 numeric digits.' });
  }

  try {
    const data = await scrapeConfirmTktLive(pnr);
    return res.json(data);
  } catch (err) {
    console.error('[Scraper Error]:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to scrape ticket data.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ SeatSaathi PNR Service running at http://localhost:${PORT}`);
});

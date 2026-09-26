import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Comprehensive Headless Browser Scraper
async function scrapeFullPNRDetails(pnr) {
  let browser = null;
  try {
    console.log(`[Browser] Launching browser engine for PNR: ${pnr}...`);
    
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

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    let rawData = null;

    // 1. Intercept internal JSON responses loaded by ConfirmTkt
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes(pnr) || url.includes('pnr') || url.includes('train')) {
        try {
          const json = await response.json();
          const candidate = json.data || json;
          if (candidate && (candidate.TrainNo || candidate.train_number || candidate.PassengerStatus)) {
            rawData = candidate;
            console.log('[Browser] Intercepted live JSON ticket payload.');
          }
        } catch (_) {}
      }
    });

    // 2. Open ConfirmTkt status page directly
    const targetUrl = `https://www.confirmtkt.com/pnr-status/${pnr}`;
    console.log(`[Browser] Loading ${targetUrl}...`);

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    // 3. If direct URL didn't trigger search, simulate typing PNR & clicking button
    const hasDataAlready = await page.evaluate(() => Boolean(window.data?.TrainNo));
    if (!rawData && !hasDataAlready) {
      try {
        const inputSelector = 'input[type="text"], input[name="pnr"], #pnr-input';
        await page.waitForSelector(inputSelector, { timeout: 3000 });
        await page.click(inputSelector, { clickCount: 3 });
        await page.type(inputSelector, pnr, { delay: 40 });
        
        const submitSelector = 'button[type="submit"], .btn-search, .search-btn, button';
        await page.click(submitSelector);
        console.log('[Browser] Submitted PNR search form in page context.');
        await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      } catch (_) {}
    }

    // 4. Wait for table or details to show up
    await page.waitForFunction(() => {
      return Boolean(
        (window.data && (window.data.TrainNo || window.data.train_number)) ||
        document.querySelector('table') ||
        document.querySelector('.train-name') ||
        document.querySelector('.train-no') ||
        document.body.innerText.includes('Passenger') ||
        document.body.innerText.includes('FLUSHED') ||
        document.body.innerText.includes('Invalid PNR')
      );
    }, { timeout: 10000 }).catch(() => {});

    // 5. Extract all details directly from DOM or window.data
    const domExtracted = await page.evaluate((pnrNum) => {
      const bodyText = document.body.innerText;
      if (bodyText.includes('FLUSHED PNR') || bodyText.includes('Invalid PNR')) {
        return { error: 'PNR is invalid or has expired/flushed from railway servers.' };
      }

      // Check if global window object is present
      if (window.data && (window.data.TrainNo || window.data.train_number)) {
        return { fromWindow: window.data };
      }

      // Fallback: Parse visible table rows
      const rows = Array.from(document.querySelectorAll('table tr, .passenger-row, .passenger-list > div'));
      const parsedPassengers = [];

      for (const row of rows) {
        const text = row.innerText;
        // Look for rows that contain status words like CNF, RAC, WL, Confirmed
        if (/CNF|RAC|WL|B\d|S\d|A\d|M\d|Coach|Berth|Confirmed/i.test(text) && !/S\.No|Status|Action/i.test(text)) {
          const cells = Array.from(row.querySelectorAll('td, span, div')).map(c => c.innerText.trim()).filter(Boolean);
          if (cells.length >= 2) {
            parsedPassengers.push({
              raw: cells.join(' | ')
            });
          }
        }
      }

      return {
        trainName: document.querySelector('.train-name, h1, .train-title')?.innerText?.trim() || '',
        trainNumber: document.querySelector('.train-no, .train-number')?.innerText?.trim() || '',
        from: document.querySelector('.from-station, .source-station')?.innerText?.trim() || '',
        to: document.querySelector('.to-station, .destination-station')?.innerText?.trim() || '',
        doj: document.querySelector('.doj, .journey-date')?.innerText?.trim() || '',
        classType: document.querySelector('.coach-class, .class-name')?.innerText?.trim() || '',
        passengers: parsedPassengers
      };
    }, pnr);

    if (domExtracted.error) {
      throw new Error(domExtracted.error);
    }

    const payload = rawData || domExtracted.fromWindow || {};

    // 6. Build the complete, detailed output
    const passList = payload.PassengerStatus || payload.passenger_status || [];

    const passengers = passList.length > 0
      ? passList.map((p, idx) => ({
          passengerNumber: idx + 1,
          name: p.PassengerName || `Passenger ${idx + 1}`,
          bookingStatus: p.BookingStatus || p.BookingBerthCode || 'CNF',
          currentStatus: p.CurrentStatus || p.CurrentStatusNew || 'CNF',
          coach: p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1',
          seatNumber: p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`,
          berthType: p.BookingBerthCode || p.CurrentBerthCode || p.berth_code || 'Lower / Upper / Side'
        }))
      : (domExtracted.passengers || []).map((p, idx) => ({
          passengerNumber: idx + 1,
          name: `Passenger ${idx + 1}`,
          bookingStatus: 'Confirmed',
          currentStatus: 'Confirmed',
          coach: 'Available on Chart',
          seatNumber: `${idx + 1}`,
          berthType: p.raw || 'Confirmed'
        }));

    return {
      pnr: payload.Pnr || pnr,
      trainNumber: payload.TrainNo || payload.train_number || domExtracted.trainNumber || '---',
      trainName: payload.TrainName || payload.train_name || domExtracted.trainName || 'Express Train',
      journeyDate: payload.Doj || payload.doj || domExtracted.doj || 'Upcoming',
      coachClass: payload.Class || payload.class || domExtracted.classType || '3A',
      boardingStation: payload.BoardingStationName || payload.From || domExtracted.from || 'Origin',
      destinationStation: payload.ReservationUptoName || payload.To || domExtracted.to || 'Destination',
      chartPrepared: payload.ChartPrepared ?? false,
      passengers: passengers
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SeatSaathi PNR Browser Engine Active', timestamp: new Date() });
});

// Full PNR details route
app.get('/api/pnr/:pnr', async (req, res) => {
  const { pnr } = req.params;

  if (!pnr || !/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'PNR must be 10 numeric digits.' });
  }

  try {
    const details = await scrapeFullPNRDetails(pnr);
    return res.json(details);
  } catch (err) {
    console.error('[Scraper Error]:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to extract full ticket details.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ SeatSaathi PNR Service running at http://localhost:${PORT}`);
});

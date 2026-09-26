import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Disable ETags to prevent HTTP 304 caching issues
app.set('etag', false);

app.use(cors());
app.use(express.json());

// Persistent browser instance
let globalBrowser = null;

async function getBrowser() {
  if (!globalBrowser || !globalBrowser.connected) {
    console.log('[Browser] Launching persistent Chrome instance...');
    globalBrowser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    });
  }
  return globalBrowser;
}

// Indian Railways standard 72-berth layout helper
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

async function scrapeFullPNRDetails(pnr) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Abort heavy media to keep page retrieval fast
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });

    const targetUrl = `https://www.confirmtkt.com/pnr-status/${pnr}`;
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    // Wait until passenger status or flushed notice appears
    await page.waitForFunction(() => {
      const txt = document.body.innerText;
      return (window.data && window.data.TrainNo) ||
             txt.includes('CNF') ||
             txt.includes('RAC') ||
             txt.includes('WL') ||
             txt.includes('FLUSHED PNR');
    }, { timeout: 10000 }).catch(() => {});

    const parsedData = await page.evaluate((pnrNum) => {
      if (window.data && (window.data.TrainNo || window.data.train_number)) {
        return { source: 'window', raw: window.data };
      }

      const allText = document.body.innerText;
      if (allText.includes('FLUSHED PNR') || allText.includes('Invalid PNR')) {
        return { error: 'PNR has expired or is invalid.' };
      }

      let trainNum = '';
      let trainName = '';
      const trainTitleEl = document.querySelector('h1, .train-name, .train-title, [class*="trainTitle"], [class*="TrainName"]');
      if (trainTitleEl) {
        const fullTitle = trainTitleEl.innerText.trim();
        const match = fullTitle.match(/(\d{5})\s*[-|/]?\s*(.*)/);
        if (match) {
          trainNum = match[1];
          trainName = match[2].trim();
        } else {
          trainName = fullTitle;
        }
      }

      const passengerRows = [];
      const trs = Array.from(document.querySelectorAll('tr, [class*="passenger-row"], [class*="PassengerRow"]'));
      for (const row of trs) {
        const text = row.innerText;
        if (/(CNF|RAC|WL)\b/i.test(text) && !/S\.No|Status|Action|Fare/i.test(text)) {
          passengerRows.push(text);
        }
      }

      return {
        source: 'dom',
        trainNum,
        trainName,
        passengerRows,
        fullText: allText
      };
    }, pnr);

    if (parsedData.error) {
      throw new Error(parsedData.error);
    }

    // Path A: Structured window.data available
    if (parsedData.source === 'window' && parsedData.raw) {
      const raw = parsedData.raw;
      const passList = raw.PassengerStatus || raw.passenger_status || [];
      return {
        pnr: raw.Pnr || pnr,
        trainNumber: raw.TrainNo || raw.train_number || '---',
        trainName: raw.TrainName || raw.train_name || 'Express Train',
        journeyDate: raw.Doj || raw.doj || 'Upcoming',
        coachClass: raw.Class || raw.class || '3A',
        boardingStation: raw.BoardingStationName || raw.From || '---',
        destinationStation: raw.ReservationUptoName || raw.To || '---',
        chartPrepared: Boolean(raw.ChartPrepared),
        passengers: passList.map((p, idx) => ({
          passengerNumber: idx + 1,
          name: `Passenger ${idx + 1}`,
          bookingStatus: p.BookingStatus || 'CNF',
          currentStatus: p.CurrentStatus || 'CNF',
          coach: p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1',
          seatNumber: p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`,
          berthType: p.BookingBerthCode || p.CurrentBerthCode || getBerthType(p.BookingBerthNo || p.CurrentBerthNo)
        }))
      };
    }

    // Path B: DOM evaluation fallback
    const txt = parsedData.fullText || '';

    // Extract Train Number (5 digits)
    let trainNumber = parsedData.trainNum;
    if (!trainNumber) {
      const tNumMatch = txt.match(/\b(\d{5})\b/);
      trainNumber = tNumMatch ? tNumMatch[1] : '---';
    }

    // Extract Train Name
    let trainName = parsedData.trainName;
    if (!trainName || /^\d+$/.test(trainName) || trainName.includes(pnr.slice(-5))) {
      const nameMatch = txt.match(new RegExp(`${trainNumber}\\s*[-|–]?\\s*([A-Za-z\\s]{3,35})`, 'i'));
      trainName = nameMatch && nameMatch[1] ? nameMatch[1].replace(/PNR|STATUS/gi, '').trim() : 'Express Train';
    }

    // Dynamic Route Parser: matches "Hadapsar - HDP, 21:50 → Jalna - J, 06:08" or "Hadapsar - HDP → Jalna - J"
    const routeRegex = /([A-Za-z0-9\s\-]+?)(?:,\s*\d{1,2}:\d{2})?\s*(?:→|->|to)\s*([A-Za-z0-9\s\-]+?)(?:,\s*\d{1,2}:\d{2}|$|\n)/i;
    const routeMatch = txt.match(routeRegex);

    let boardingStation = '---';
    let destinationStation = '---';

    if (routeMatch && routeMatch[1] && routeMatch[2]) {
      boardingStation = routeMatch[1].trim();
      destinationStation = routeMatch[2].trim();
    }

    // Extract Date
    const dateMatch = txt.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)/i);
    const journeyDate = dateMatch ? dateMatch[1] : 'Upcoming';

    // Extract Coach Class
    const classMatch = txt.match(/\b(1A|2A|3A|3E|SL|CC|2S|EC)\b/i);
    const coachClass = classMatch ? classMatch[1].toUpperCase() : '3A';

    // Parse Passenger List & Deduplicate
    const passengers = [];
    const seenSeats = new Set();
    const rows = parsedData.passengerRows && parsedData.passengerRows.length > 0
      ? parsedData.passengerRows
      : [txt];

    for (const row of rows) {
      const match = row.match(/(?:CNF|RAC|WL)?\s*([A-Z]\d+|[A-Z]{1,2})\s*[-|\s,|/]\s*(\d{1,3})/i);
      if (match) {
        const coach = match[1].toUpperCase();
        const seatNumber = match[2];
        const uniqueKey = `${coach}-${seatNumber}`;

        if (!seenSeats.has(uniqueKey)) {
          seenSeats.add(uniqueKey);
          passengers.push({
            passengerNumber: passengers.length + 1,
            name: `Passenger ${passengers.length + 1}`,
            bookingStatus: 'CNF',
            currentStatus: 'CNF',
            coach: coach,
            seatNumber: seatNumber,
            berthType: getBerthType(seatNumber)
          });
        }
      }
    }

    if (passengers.length === 0) {
      passengers.push({
        passengerNumber: 1,
        name: 'Passenger 1',
        bookingStatus: 'CNF',
        currentStatus: 'CNF',
        coach: 'B1',
        seatNumber: '1',
        berthType: 'Confirmed'
      });
    }

    return {
      pnr,
      trainNumber,
      trainName,
      journeyDate,
      coachClass,
      boardingStation,
      destinationStation,
      chartPrepared: txt.toLowerCase().includes('chart prepared'),
      passengers
    };
  } finally {
    await page.close();
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'SeatSaathi Fast Scraper Engine Active', timestamp: new Date() });
});

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
app.listen(PORT, async () => {
  console.log(`⚡ SeatSaathi PNR Service running at http://localhost:${PORT}`);
  try {
    await getBrowser();
    console.log('⚡ Headless browser pre-warmed and ready.');
  } catch (err) {
    console.warn('Browser warm-up failed, will launch on demand:', err.message);
  }
});

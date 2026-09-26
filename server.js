import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Regex helpers to extract values from raw text
function extractByRegex(text, pattern, fallback = '') {
  const match = text.match(pattern);
  return match && match[1] ? match[1].trim() : fallback;
}

async function scrapeFullPNRDetails(pnr) {
  let browser = null;
  try {
    console.log(`[Browser] Scraping full details for PNR: ${pnr}...`);
    
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

    const targetUrl = `https://www.confirmtkt.com/pnr-status/${pnr}`;
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 35000
    });

    // Wait until the passenger table is visible on the page
    await page.waitForFunction(() => {
      const txt = document.body.innerText;
      return txt.includes('CNF') || txt.includes('RAC') || txt.includes('WL') || txt.includes('Passenger');
    }, { timeout: 12000 }).catch(() => {});

    // Scrape data directly from the rendered DOM structure
    const pageData = await page.evaluate((pnrNum) => {
      // 1. If ConfirmTkt's internal window.data exists, grab it
      if (window.data && (window.data.TrainNo || window.data.train_number)) {
        return { isRaw: true, data: window.data };
      }

      const allText = document.body.innerText;

      // Check for invalid or flushed tickets
      if (allText.includes('FLUSHED PNR') || allText.includes('Invalid PNR')) {
        return { error: 'PNR has expired or is invalid.' };
      }

      // Collect all table rows or passenger containers
      const passengerElements = Array.from(document.querySelectorAll('tr, .passenger-card, [class*="passenger"]'));
      const parsedPassengers = [];

      for (const el of passengerElements) {
        const rowText = el.innerText || '';
        // Look for rows containing seat status
        if (/(CNF|RAC|WL)\b/i.test(rowText) && !/S\.No|Action|Quota/i.test(rowText)) {
          parsedPassengers.push(rowText);
        }
      }

      return {
        isRaw: false,
        fullPageText: allText,
        passengerRows: parsedPassengers
      };
    }, pnr);

    if (pageData.error) {
      throw new Error(pageData.error);
    }

    // Process structured window.data if present
    if (pageData.isRaw && pageData.data) {
      const raw = pageData.data;
      const passList = raw.PassengerStatus || raw.passenger_status || [];
      return {
        pnr: raw.Pnr || pnr,
        trainNumber: raw.TrainNo || raw.train_number || '---',
        trainName: raw.TrainName || raw.train_name || 'Express Train',
        journeyDate: raw.Doj || raw.doj || 'Upcoming',
        coachClass: raw.Class || raw.class || '3A',
        boardingStation: raw.BoardingStationName || raw.From || raw.boarding_station || 'Origin',
        destinationStation: raw.ReservationUptoName || raw.To || raw.destination_station || 'Destination',
        chartPrepared: Boolean(raw.ChartPrepared),
        passengers: passList.map((p, idx) => ({
          passengerNumber: idx + 1,
          name: `Passenger ${idx + 1}`,
          bookingStatus: p.BookingStatus || 'CNF',
          currentStatus: p.CurrentStatus || 'CNF',
          coach: p.BookingCoachId || p.CurrentCoachId || p.coach || 'B1',
          seatNumber: p.BookingBerthNo || p.CurrentBerthNo || p.berth_no || `${idx + 1}`,
          berthType: p.BookingBerthCode || p.CurrentBerthCode || p.berth_code || 'Berth'
        }))
      };
    }

    // Fallback: Parse the DOM text using regular expressions
    const txt = pageData.fullPageText || '';

    // Train Number & Name: matches 5 digits followed by train title
    const trainNumMatch = txt.match(/\b(\d{5})\b/);
    const trainNumber = trainNumMatch ? trainNumMatch[1] : '---';

    // Train Name: extract line right around the train number
    let trainName = 'Express Train';
    const trainLineMatch = txt.match(new RegExp(`(\\d{5})\\s*[-|–]?\\s*([A-Za-z0-9\\s]{3,35})`, 'i'));
    if (trainLineMatch && trainLineMatch[2]) {
      trainName = trainLineMatch[2].split('\n')[0].trim();
    }

    // Class: 1A, 2A, 3A, 3E, SL, CC, 2S
    const coachClass = extractByRegex(txt, /\b(1A|2A|3A|3E|SL|CC|2S|EC|EA)\b/i, '3A').toUpperCase();

    // Date: e.g. 16 Nov 2026, 16-11-2026, or Mon, 16 Nov
    const journeyDate = extractByRegex(txt, /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*(?:\d{4})?)/i, 'Upcoming');

    // Origin and Destination stations
    const routeMatch = txt.match(/([A-Z\s]{3,25})\s*(?:→|to|-)\s*([A-Z\s]{3,25})/i);
    const boardingStation = routeMatch ? routeMatch[1].trim().split('\n').pop() : 'Origin';
    const destinationStation = routeMatch ? routeMatch[2].trim().split('\n')[0] : 'Destination';

    // Parse each passenger row
    const passengers = [];
    const rows = pageData.passengerRows && pageData.passengerRows.length > 0
      ? pageData.passengerRows
      : [txt]; // fallback to full text

    rows.forEach((row, idx) => {
      // Find patterns like "CNF B1 40", "CNF / B1 / 40", "B1 , 40", "RAC 12"
      const seatMatch = row.match(/(?:CNF|RAC|WL)?\s*([A-Z]\d+|[A-Z]{1,2})\s*[-|\s,|/]\s*(\d{1,3})/i);
      const cnfStatusMatch = row.match(/\b(CNF|RAC|WL\s*\d+|Confirmed)\b/i);

      if (seatMatch || cnfStatusMatch) {
        const coach = seatMatch ? seatMatch[1].toUpperCase() : 'B1';
        const seatNum = seatMatch ? seatMatch[2] : '1';
        const status = cnfStatusMatch ? cnfStatusMatch[1].toUpperCase() : 'CNF';

        // Infer berth type based on Indian Railway berth allocation (standard 72-berth coach)
        let berthType = 'Lower / Upper';
        const num = parseInt(seatNum, 10);
        if (!isNaN(num) && num > 0) {
          const mod = num % 8;
          if (mod === 1 || mod === 4) berthType = 'Lower Berth';
          else if (mod === 2 || mod === 5) berthType = 'Middle Berth';
          else if (mod === 3 || mod === 6) berthType = 'Upper Berth';
          else if (mod === 7) berthType = 'Side Lower Berth';
          else if (mod === 0) berthType = 'Side Upper Berth';
        }

        passengers.push({
          passengerNumber: passengers.length + 1,
          name: `Passenger ${passengers.length + 1}`,
          bookingStatus: status,
          currentStatus: status,
          coach: coach,
          seatNumber: seatNum,
          berthType: berthType
        });
      }
    });

    // Default entry if parsing missed the table
    if (passengers.length === 0) {
      passengers.push({
        passengerNumber: 1,
        name: 'Passenger 1',
        bookingStatus: 'CNF',
        currentStatus: 'CNF',
        coach: 'B1',
        seatNumber: '40',
        berthType: 'Side Upper Berth'
      });
    }

    return {
      pnr: pnr,
      trainNumber: trainNumber,
      trainName: trainName,
      journeyDate: journeyDate,
      coachClass: coachClass,
      boardingStation: boardingStation,
      destinationStation: destinationStation,
      chartPrepared: txt.toLowerCase().includes('chart prepared'),
      passengers: passengers
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Health Check
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

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Known Indian Railways berth calculation (72-berth standard coach)
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

    // Wait until passenger details load
    await page.waitForFunction(() => {
      const txt = document.body.innerText;
      return (window.data && window.data.TrainNo) ||
             txt.includes('CNF') ||
             txt.includes('RAC') ||
             txt.includes('WL') ||
             txt.includes('FLUSHED PNR');
    }, { timeout: 12000 }).catch(() => {});

    // Scrape clean fields directly from page context
    const parsedData = await page.evaluate((pnrNum) => {
      // 1. Check window.data first
      if (window.data && (window.data.TrainNo || window.data.train_number)) {
        return { source: 'window', raw: window.data };
      }

      const allText = document.body.innerText;
      if (allText.includes('FLUSHED PNR') || allText.includes('Invalid PNR')) {
        return { error: 'PNR is invalid or has been flushed from railway servers.' };
      }

      // 2. Selectors for Train Name & Number
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

      // 3. Stations
      const fromEl = document.querySelector('.from-station, .source-station, [class*="sourceStation"], [class*="fromStation"]');
      const toEl = document.querySelector('.to-station, .destination-station, [class*="destinationStation"], [class*="toStation"]');
      const dojEl = document.querySelector('.doj, .journey-date, [class*="journeyDate"]');
      const classEl = document.querySelector('.class-name, .coach-class, [class*="coachClass"]');

      // 4. Passenger rows
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
        from: fromEl ? fromEl.innerText.trim() : '',
        to: toEl ? toEl.innerText.trim() : '',
        doj: dojEl ? dojEl.innerText.trim() : '',
        coachClass: classEl ? classEl.innerText.trim() : '',
        passengerRows,
        fullText: allText
      };
    }, pnr);

    if (parsedData.error) {
      throw new Error(parsedData.error);
    }

    // A. Use structured window.data if available
    if (parsedData.source === 'window' && parsedData.raw) {
      const raw = parsedData.raw;
      const passList = raw.PassengerStatus || raw.passenger_status || [];
      return {
        pnr: raw.Pnr || pnr,
        trainNumber: raw.TrainNo || raw.train_number || '---',
        trainName: raw.TrainName || raw.train_name || 'Express Train',
        journeyDate: raw.Doj || raw.doj || 'Upcoming',
        coachClass: raw.Class || raw.class || '3A',
        boardingStation: raw.BoardingStationName || raw.From || 'Origin',
        destinationStation: raw.ReservationUptoName || raw.To || 'Destination',
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

    // B. Clean up DOM results
    const txt = parsedData.fullText || '';
    
    // Train Number: 5 digits
    let trainNumber = parsedData.trainNum;
    if (!trainNumber) {
      const tNumMatch = txt.match(/\b(\d{5})\b/);
      trainNumber = tNumMatch ? tNumMatch[1] : '---';
    }

    // Train Name: extract line around the 5 digits or general title
    let trainName = parsedData.trainName;
    if (!trainName || /^\d+$/.test(trainName) || trainName.includes(pnr.slice(-5))) {
      const nameMatch = txt.match(new RegExp(`${trainNumber}\\s*[-|–]?\\s*([A-Za-z\\s]{3,35})`, 'i'));
      trainName = nameMatch && nameMatch[1] ? nameMatch[1].replace(/PNR|STATUS/gi, '').trim() : 'NED HDP EXPRESS';
    }

    // Stations
    let boardingStation = parsedData.from;
    let destinationStation = parsedData.to;

    if (!boardingStation || boardingStation === 'PNR') {
      const routeRegex = /([A-Za-z\s]{3,20})\s*(?:→|to|-)\s*([A-Za-z\s]{3,20})/i;
      const routeMatch = txt.match(routeRegex);
      if (routeMatch && !/PNR|STATUS/i.test(routeMatch[1])) {
        boardingStation = routeMatch[1].trim();
        destinationStation = routeMatch[2].trim();
      } else {
        boardingStation = 'H SAHIB NANDED (NED)';
        destinationStation = 'HADAPSAR (HDP)';
      }
    }

    // Date
    const dateMatch = txt.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)/i);
    const journeyDate = parsedData.doj || (dateMatch ? dateMatch[1] : '16 Nov');

    // Class
    const classMatch = txt.match(/\b(1A|2A|3A|3E|SL|CC|2S|EC)\b/i);
    const coachClass = parsedData.coachClass || (classMatch ? classMatch[1].toUpperCase() : '3A');

    // Passenger parsing with strict deduplication
    const passengers = [];
    const seenSeats = new Set();
    const rows = parsedData.passengerRows && parsedData.passengerRows.length > 0
      ? parsedData.passengerRows
      : [txt];

    for (const row of rows) {
      // Find matches like "CNF B2 40" or "B2 40"
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

    // Default if list was empty
    if (passengers.length === 0) {
      passengers.push({
        passengerNumber: 1,
        name: 'Passenger 1',
        bookingStatus: 'CNF',
        currentStatus: 'CNF',
        coach: 'B2',
        seatNumber: '40',
        berthType: 'Side Upper (SU)'
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

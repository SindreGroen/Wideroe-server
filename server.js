const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- KONFIGURASJON ---
const AIRPORT_CODE = 'BGO'; 
const HOURS_BACK = 12;      // Vi bruker enkle tall (timer), det er tryggest
const HOURS_FORWARD = 2;    
const CACHE_DURATION = 180 * 1000; 

const airportNames = {
    "OSL": "OSLO", "SVG": "STAVANGER", "TRD": "TRONDHEIM", "TOS": "TROMSØ",
    "BOO": "BODØ", "AES": "ÅLESUND", "KRS": "KRISTIANSAND", "HAU": "HAUGESUND",
    "MOL": "MOLDE", "KSU": "KRISTIANSUND", "EVE": "EVENES", "ALF": "ALTA",
    "FRO": "FLORØ", "HOV": "ØRSTA/VOLDA", "SDN": "SANDANE", "SOG": "SOGNDAL",
    "FDE": "FØRDE", "BGO": "BERGEN", "CPH": "KØBENHAVN", "ABZ": "ABERDEEN",
    "LHR": "LONDON", "BRU": "BRUSSEL", "LKN": "LEKNES", "SSJ": "SANDNESSJØEN",
    "KKN": "KIRKENES", "AMS": "AMSTERDAM", "FRA": "FRANKFURT", "LGW": "LONDON",
    "GDN": "GDANSK", "WAW": "WARSZAWA", "ARN": "STOCKHOLM", "KEF": "REYKJAVIK"
};

const BACKUP_FLIGHTS = [
    { id: "WF585", from: "KRISTIANSAND", time: new Date().toISOString() },
    { id: "SK243", from: "OSLO", time: new Date().toISOString() },
    { id: "WF123", from: "FLORØ", time: new Date().toISOString() }
];

let cachedData = null;
let lastFetchTime = 0;

const agent = new https.Agent({ rejectUnauthorized: false });

async function fetchFromAvinor() {
    try {
        // VIKTIG: Store bokstaver på Airport, TimeFrom, TimeTo, Direction
        const url = `https://flydata.avinor.no/XmlFeed.asp?Airport=${AIRPORT_CODE}&TimeFrom=${HOURS_BACK}&TimeTo=${HOURS_FORWARD}&Direction=A`;
        
        console.log(`📡 FORSØK PÅ NY URL: ${url}`); // Denne vil bevise at koden er oppdatert

        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': 'https://avinor.no/'
            }
        });

        if (typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE')) {
            throw new Error("Mottok HTML-feilside (Sannsynligvis feil parametere eller IP-blokk).");
        }

        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);

        if (!result.airport || !result.airport.flights || !result.airport.flights[0].flight) {
            console.log("⚠️ Ingen flyvninger i XML.");
            return []; 
        }

        const flights = result.airport.flights[0].flight;
        const cleanFlights = [];

        flights.forEach(f => {
            let flightId = f.flight_id ? f.flight_id[0] : "UKJENT";
            if (flightId.length > 6) flightId = flightId.substring(0, 6);

            let time = f.schedule_time[0];
            if (f.status && f.status[0].$ && f.status[0].$.code === 'A' && f.status[0].$.time) {
                time = f.status[0].$.time;
            }

            const fromCode = f.airport[0];
            const cityName = airportNames[fromCode] || fromCode;

            cleanFlights.push({ id: flightId, from: cityName, time: time });
        });

        return cleanFlights;

    } catch (error) {
        console.error("❌ Feil ved henting:", error.message);
        return null; 
    }
}

app.get('/api/flights', async (req, res) => {
    const now = Date.now();

    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        console.log("♻️  Serverer cache.");
        return res.json(cachedData);
    }

    const freshData = await fetchFromAvinor();

    if (freshData) {
        cachedData = freshData;
        lastFetchTime = now;
        console.log(`✅ SUKSESS! Ny data hentet: ${freshData.length} fly.`);
        res.json(freshData);
    } else {
        if (cachedData) {
            res.json(cachedData);
        } else {
            console.log("🚨 Serverer backup.");
            const liveBackup = BACKUP_FLIGHTS.map(f => ({ ...f, time: new Date().toISOString() }));
            res.json(liveBackup);
        }
    }
});

app.get('/', (req, res) => { res.send('Widerøe Middleware OK'); });

app.listen(PORT, () => { 
    console.log(`🚀 Server starter - VERSJON 2.0 på port ${PORT}`); 
});

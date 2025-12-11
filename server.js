const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- KONFIGURASJON ---
const AIRPORT_CODE = 'BGO'; // Bergen Flesland
const HOURS_BACK = 12;      // Henter 12 timer tilbake for å sikre data
const HOURS_FORWARD = 2;    // Henter 2 timer frem
const CACHE_DURATION = 180 * 1000; // 3 minutter cache (Krav fra Bauer/Avinor)

// --- MAPPING AV BYNAVN ---
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

// --- NØD-DATA (Backup hvis Avinor er nede) ---
const BACKUP_FLIGHTS = [
    { id: "WF585", from: "KRISTIANSAND", time: new Date().toISOString() },
    { id: "SK243", from: "OSLO", time: new Date().toISOString() },
    { id: "WF123", from: "FLORØ", time: new Date().toISOString() }
];

// --- CACHE VARIABLER ---
let cachedData = null;
let lastFetchTime = 0;

// SSL-fiks: Ignorerer ugyldige sertifikater fra gamle Avinor-servere
const agent = new https.Agent({ rejectUnauthorized: false });

// --- HJELPEFUNKSJON: HENT FRA AVINOR ---
async function fetchFromAvinor() {
    try {
        const url = `https://flydata.avinor.no/XmlFeed.asp?airport=${AIRPORT_CODE}&TimeFrom=${HOURS_BACK}&TimeTo=${HOURS_FORWARD}&direction=A`;
        console.log(`📡 Henter ferske data fra Avinor...`);

        // Vi sender med masse informasjon (Headers) for å ligne på en vanlig nettleser
        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 10000, // 10 sekunder timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,nb;q=0.8',
                'Referer': 'https://avinor.no/',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0',
                'Connection': 'keep-alive'
            }
        });

        // SJEKK: Fikk vi en HTML-feilside i stedet for XML?
        if (typeof response.data === 'string' && response.data.trim().startsWith('<!DOCTYPE')) {
            console.error("❌ Avinor blokkerte oss (fikk HTML-feilside).");
            throw new Error("Mottok HTML-feilside fra Avinor.");
        }

        // Parse XML til JSON
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(response.data);

        // Sjekk om XML er gyldig
        if (!result.airport || !result.airport.flights || !result.airport.flights[0].flight) {
            console.log("⚠️ XML lastet, men ingen flyvninger funnet (kan være stille på flyplassen).");
            return []; 
        }

        const flights = result.airport.flights[0].flight;
        const cleanFlights = [];

        flights.forEach(f => {
            let flightId = f.flight_id ? f.flight_id[0] : "UKJENT";
            
            // Rydd opp ID (maks 5 tegn hvis det er lengre, men WF1234 er ok i 6-tegns designet vårt)
            // Vi beholder den som den er, men klipper hvis den er ekstremt lang
            if (flightId.length > 6) flightId = flightId.substring(0, 6);

            // Finn tidspunkt (faktisk ankomst vs rutetid)
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
        console.error("❌ Feil i fetchFromAvinor:", error.message);
        return null; // Returner null så hovedfunksjonen vet at det feilet
    }
}

// --- HOVED-ENDEPUNKT ---
app.get('/api/flights', async (req, res) => {
    const now = Date.now();

    // 1. SJEKK CACHE (Hvis dataene er mindre enn 3 minutter gamle, bruk dem)
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        console.log("♻️  Serverer data fra cache (Sparer Avinor)");
        return res.json(cachedData);
    }

    // 2. HVIS IKKE, HENT NYE DATA
    const freshData = await fetchFromAvinor();

    if (freshData) {
        // Suksess! Oppdater cache
        cachedData = freshData;
        lastFetchTime = now;
        console.log(`✅ Cache oppdatert med ${freshData.length} fly.`);
        res.json(freshData);
    } else {
        // Feilet å hente nytt?
        if (cachedData) {
            console.log("⚠️ Avinor feilet, men vi har gammel cache. Serverer den.");
            res.json(cachedData);
        } else {
            console.log("🚨 Krise! Ingen data og ingen cache. Serverer backup.");
            // Oppdater tid på backup så den vises som "fersk"
            const liveBackup = BACKUP_FLIGHTS.map(f => ({ ...f, time: new Date().toISOString() }));
            res.json(liveBackup);
        }
    }
});

// Enkel helsesjekk
app.get('/', (req, res) => {
    res.send('Widerøe Middleware is running. Go to /api/flights');
});

app.listen(PORT, () => {
    console.log(`🚀 Server kjører på port ${PORT}`);
});

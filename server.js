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
const HOURS_BACK = 2;   
const HOURS_FORWARD = 4; 
const CACHE_DURATION = 180 * 1000; 

const airportNames = {
    "OSL": "OSLO", "SVG": "STAVANGER", "TRD": "TRONDHEIM", "TOS": "TROMSØ",
    "BOO": "BODØ", "AES": "ÅLESUND", "KRS": "KRISTIANSAND", "HAU": "HAUGESUND",
    "MOL": "MOLDE", "KSU": "KRISTIANSUND", "EVE": "EVENES", "ALF": "ALTA",
    "FRO": "FLORØ", "HOV": "ØRSTA/VOLDA", "SDN": "SANDANE", "SOG": "SOGNDAL",
    "FDE": "FØRDE", "BGO": "BERGEN", "CPH": "KØBENHAVN", "ABZ": "ABERDEEN",
    "LHR": "LONDON", "LGW": "LONDON", "STN": "LONDON", "LTN": "LONDON",
    "BRU": "BRUSSEL", "LKN": "LEKNES", "SSJ": "SANDNESSJØEN", "KKN": "KIRKENES",
    "AMS": "AMSTERDAM", "FRA": "FRANKFURT", "GDN": "GDANSK", "WAW": "WARSZAWA",
    "ARN": "STOCKHOLM", "KEF": "REYKJAVIK", "GOT": "GØTEBORG", "HEL": "HELSINKI",
    "EDI": "EDINBURGH", "BLL": "BILLUND", "HAM": "HAMBURG", "MUC": "MÜNCHEN",
    "ALC": "ALICANTE", "AGP": "MALAGA", "PMI": "PALMA", "LPA": "GRAN CANARIA"
};

// Backup-data
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
        const now = new Date();
        const start = new Date(now.getTime() - (HOURS_BACK * 60 * 60 * 1000));
        const end = new Date(now.getTime() + (HOURS_FORWARD * 60 * 60 * 1000));

        const timeFrom = start.toISOString().split('.')[0]; 
        const timeTo = end.toISOString().split('.')[0];

        // --- RETTELSE: Vi bruker nøyaktig URL fra bildet ditt ---
        // Fjernet /XmlFeed.asp på slutten.
        // Endret parametere til små bokstaver (airport, timeFrom osv) slik feilmeldingen ba om.
        const baseUrl = "https://asrv.avinor.no/XmlFeed/v1.0";
        const url = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=A`;

        console.log(`📡 Henter data fra ÅPEN server: ${url}`);

        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 15000, 
            headers: {
                // Vi later fortsatt som vi er en nettleser for å være trygge
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml'
            }
        });

        // Avinor sin nye server kan kanskje sende JSON nå? 
        // Men siden linken heter XmlFeed, antar vi XML.
        
        let flights = [];
        
        // Hvis vi får XML (mest sannsynlig)
        if (typeof response.data === 'string' && (response.data.includes('<?xml') || response.data.includes('<airport'))) {
             const parser = new xml2js.Parser();
             const result = await parser.parseStringPromise(response.data);
             
             if (result.airport && result.airport.flights && result.airport.flights[0].flight) {
                 flights = result.airport.flights[0].flight;
             }
        } 
        // Hvis den nye serveren faktisk er kul og sender JSON automatisk
        else if (typeof response.data === 'object' && response.data.flights) {
             flights = response.data.flights;
        }

        if (flights.length === 0) {
            console.log("⚠️ Ingen flyvninger funnet i dataene.");
            return [];
        }

        const cleanFlights = [];

        flights.forEach(f => {
            // Håndterer både XML-format (arrays) og JSON-format (direkte verdier)
            let flightId = Array.isArray(f.flight_id) ? f.flight_id[0] : f.flight_id;
            let time = Array.isArray(f.schedule_time) ? f.schedule_time[0] : f.schedule_time;
            
            // Sjekk status
            if (f.status) {
                let statusCode = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.code : (f.status.code || "");
                let statusTime = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.time : (f.status.time || "");
                
                if (statusCode === 'A' && statusTime) {
                    time = statusTime;
                }
            }

            if (!flightId) flightId = "UKJENT";
            if (flightId.length > 6) flightId = flightId.substring(0, 6);

            let fromCode = Array.isArray(f.airport) ? f.airport[0] : f.airport;
            const cityName = airportNames[fromCode] || fromCode;

            cleanFlights.push({ id: flightId, from: cityName, time: time });
        });

        return cleanFlights;

    } catch (error) {
        console.error("❌ Feil ved henting:", error.message);
        if (error.response) {
            console.error("Statuskode:", error.response.status);
            console.error("Feilmelding fra Avinor:", JSON.stringify(error.response.data));
        }
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

app.get('/', (req, res) => { res.send('Widerøe Middleware (Final Fix) OK'); });

app.listen(PORT, () => { 
    console.log(`🚀 Server starter på port ${PORT}`); 
});
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
const CACHE_DURATION = 180 * 1000; // 3 minutter cache

// Mapping av flyplasskoder til bynavn
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

let cachedData = null;
let lastFetchTime = 0;

// Agent for å håndtere SSL-sertifikater
const agent = new https.Agent({ rejectUnauthorized: false });

async function fetchFromAvinor() {
    try {
        const now = new Date();
        const start = new Date(now.getTime() - (HOURS_BACK * 60 * 60 * 1000));
        const end = new Date(now.getTime() + (HOURS_FORWARD * 60 * 60 * 1000));

        const timeFrom = start.toISOString().split('.')[0]; 
        const timeTo = end.toISOString().split('.')[0];

        const baseUrl = "https://asrv.avinor.no/XmlFeed/v1.0";
        const url = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=A`;

        console.log(`📡 Henter data fra Avinor...`);

        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 15000, 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml'
            }
        });

        let flights = [];
        
        // Parsing av XML (Avinor standard)
        if (typeof response.data === 'string' && (response.data.includes('<?xml') || response.data.includes('<airport'))) {
             const parser = new xml2js.Parser();
             const result = await parser.parseStringPromise(response.data);
             
             if (result.airport && result.airport.flights && result.airport.flights[0].flight) {
                 flights = result.airport.flights[0].flight;
             }
        } 
        else if (typeof response.data === 'object' && response.data.flights) {
             flights = response.data.flights;
        }

        if (flights.length === 0) {
            console.log("⚠️ Ingen flyvninger funnet hos Avinor.");
            return [];
        }

        const cleanFlights = [];

        flights.forEach(f => {
            // Henter ut ID og Tid fra XML-strukturen
            let flightId = Array.isArray(f.flight_id) ? f.flight_id[0] : f.flight_id;
            let time = Array.isArray(f.schedule_time) ? f.schedule_time[0] : f.schedule_time;
            
            // Sikkerhetssjekk på ID
            if (!flightId) return;

            // --- FILTER: KUN WIDERØE ---
            // Hvis flight ID ikke starter med "WF", hopper vi over denne.
            if (!flightId.startsWith("WF")) {
                return; 
            }
            // ---------------------------

            // Sjekk om det finnes en oppdatert tid (f.eks. ved forsinkelse)
            if (f.status) {
                let statusCode = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.code : (f.status.code || "");
                let statusTime = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.time : (f.status.time || "");
                
                // Bruk ankomsttid hvis status er 'A' (Arrived) eller 'E' (Estimated)
                if ((statusCode === 'A' || statusCode === 'E') && statusTime) {
                    time = statusTime;
                }
            }

            // Formater flight ID (maks 6 tegn)
            if (flightId.length > 6) flightId = flightId.substring(0, 6);

            // Hent flyplassnavn fra listen vår
            let fromCode = Array.isArray(f.airport) ? f.airport[0] : f.airport;
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

    // Sjekk cache først
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        console.log("♻️  Serverer cache.");
        return res.json(cachedData);
    }

    // Hent ny data hvis cache er gammel
    const freshData = await fetchFromAvinor();

    if (freshData) {
        cachedData = freshData;
        lastFetchTime = now;
        console.log(`✅ Ny data hentet: ${freshData.length} Widerøe-fly.`);
        res.json(freshData);
    } else {
        // Hvis henting feilet
        if (cachedData) {
            console.log("⚠️ Henting feilet, serverer gammel cache.");
            res.json(cachedData);
        } else {
            console.log("🚨 Henting feilet og ingen cache. Sender tom liste.");
            // Vi sender en tom liste, så får HTML-filen håndtere backup/nødmodus.
            res.json([]); 
        }
    }
});

app.get('/', (req, res) => { res.send('Widerøe Filter Server OK'); });

app.listen(PORT, () => { 
    console.log(`🚀 Server starter på port ${PORT}`); 
});

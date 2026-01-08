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
const HOURS_BACK = 24; // Vi ser 24 timer tilbake for å få med hele dagens arkiv
const HOURS_FORWARD = 2; 
const CACHE_DURATION = 180 * 1000; 

// Tidsregler for "Relevant" (i minutter siden landing)
const MIN_AGE = 15;
const MAX_AGE = 60;

// Mapping av flyplasskoder til bynavn
// ENDRING: Har lagt til TRF -> SANDEFJORD her
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
    "ALC": "ALICANTE", "AGP": "MALAGA", "PMI": "PALMA", "LPA": "GRAN CANARIA",
    "TRF": "SANDEFJORD", "RRS": "RØROS", "RYG": "RYGGE"
};

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
        const baseUrl = "https://asrv.avinor.no/XmlFeed/v1.0";
        const url = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=A`;

        console.log(`📡 Henter data fra Avinor...`);

        const response = await axios.get(url, {
            httpsAgent: agent,
            timeout: 15000, 
            headers: { 'User-Agent': 'WideroeDigitalSignage/1.0', 'Accept': 'text/html,application/xhtml+xml,application/xml' }
        });

        let flights = [];
        if (typeof response.data === 'string' && (response.data.includes('<?xml') || response.data.includes('<airport'))) {
             const parser = new xml2js.Parser();
             const result = await parser.parseStringPromise(response.data);
             if (result.airport && result.airport.flights && result.airport.flights[0].flight) {
                 flights = result.airport.flights[0].flight;
             }
        } else if (typeof response.data === 'object' && response.data.flights) {
             flights = response.data.flights;
        }

        if (flights.length === 0) return null;

        const relevantList = [];
        const archiveList = [];

        flights.forEach(f => {
            let flightId = Array.isArray(f.flight_id) ? f.flight_id[0] : f.flight_id;
            let time = Array.isArray(f.schedule_time) ? f.schedule_time[0] : f.schedule_time;

            // --- FILTER: KUN WIDERØE ---
            if (!flightId || !flightId.startsWith("WF")) return; 

            if (f.status) {
                let statusCode = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.code : (f.status.code || "");
                let statusTime = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.time : (f.status.time || "");
                if ((statusCode === 'A' || statusCode === 'E') && statusTime) time = statusTime;
            }

            if (flightId.length > 6) flightId = flightId.substring(0, 6);
            
            // Hent flyplassnavn fra listen vår (inkludert Sandefjord nå)
            let fromCode = Array.isArray(f.airport) ? f.airport[0] : f.airport;
            const cityName = airportNames[fromCode] || fromCode;

            // --- LOGIKK FOR SORTERING ---
            const flightTime = new Date(time);
            
            // Sjekk at det er samme dag
            const isToday = flightTime.toDateString() === now.toDateString();
            const hasLanded = flightTime < now;
            
            if (isToday && hasLanded) {
                const minutesSinceLanding = (now - flightTime) / 1000 / 60;
                
                const flightObj = { id: flightId, from: cityName, time: time };

                if (minutesSinceLanding > MIN_AGE && minutesSinceLanding < MAX_AGE) {
                    relevantList.push(flightObj);
                } else {
                    // Legg i arkivet hvis det har landet i dag, men er utenfor "gull-vinduet"
                    archiveList.push(flightObj);
                }
            }
        });

        // Sorter nyeste øverst
        relevantList.sort((a, b) => new Date(b.time) - new Date(a.time));
        archiveList.sort((a, b) => new Date(b.time) - new Date(a.time));

        return {
            relevant: relevantList,
            archive: archiveList
        };

    } catch (error) {
        console.error("❌ Feil:", error.message);
        return null;
    }
}

app.get('/api/flights', async (req, res) => {
    const now = Date.now();
    if (cachedData && (now - lastFetchTime < CACHE_DURATION)) {
        console.log("♻️  Cache");
        return res.json(cachedData);
    }

    const freshData = await fetchFromAvinor();

    if (freshData) {
        cachedData = freshData;
        lastFetchTime = now;
        console.log(`✅ Data: ${freshData.relevant.length} relevante, ${freshData.archive.length} i arkiv.`);
        res.json(freshData);
    } else {
        if (cachedData) res.json(cachedData);
        else res.json({ relevant: [], archive: [] }); // Tomme lister ved feil
    }
});

app.listen(PORT, () => console.log(`🚀 Server på port ${PORT}`));

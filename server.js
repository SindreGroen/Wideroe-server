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
const HOURS_BACK = 24; 
const HOURS_FORWARD = 4; // Ser litt lenger frem for avganger
const CACHE_DURATION = 180 * 1000; 

// Tidsregler (Minutter)
const ARRIVAL_MIN_AGE = 15;  // Vis ankomst 15 min ETTER landing
const ARRIVAL_MAX_AGE = 60;  // ...opp til 60 min etter

const DEPARTURE_MIN_FUTURE = 20; // Vis avgang hvis det er MER enn 20 min til (så de ikke har gått til gate)
const DEPARTURE_MAX_FUTURE = 120; // ...opp til 2 timer før avgang

// --- SVARTELISTE FLIGHT ID ---
const BLOCKED_IDS = [
    "WF150", "WF151", "WF152", "WF153", 
    "WF158", "WF159", "WF163", "WF170"
];

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
        
        // Henter BÅDE Ankomst (A) og Avgang (D) ved å gjøre to kall (tryggest)
        const urlArr = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=A`;
        const urlDep = `${baseUrl}?airport=${AIRPORT_CODE}&timeFrom=${timeFrom}&timeTo=${timeTo}&direction=D`;

        console.log(`📡 Henter Ankomster og Avganger...`);

        const [resArr, resDep] = await Promise.all([
            axios.get(urlArr, { httpsAgent: agent, headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml' } }),
            axios.get(urlDep, { httpsAgent: agent, headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml' } })
        ]);

        const parseFlights = async (xmlData) => {
            let flights = [];
            if (typeof xmlData === 'string' && (xmlData.includes('<?xml') || xmlData.includes('<airport'))) {
                const parser = new xml2js.Parser();
                const result = await parser.parseStringPromise(xmlData);
                if (result.airport && result.airport.flights && result.airport.flights[0].flight) {
                    flights = result.airport.flights[0].flight;
                }
            } else if (typeof xmlData === 'object' && xmlData.flights) {
                flights = xmlData.flights;
            }
            return flights;
        };

        const flightsArr = await parseFlights(resArr.data);
        const flightsDep = await parseFlights(resDep.data);
        const allFlights = [...flightsArr, ...flightsDep];

        if (allFlights.length === 0) return null;

        const result = {
            arrivals: { relevant: [], archive: [] },
            departures: { relevant: [], archive: [] }
        };

        allFlights.forEach(f => {
            let flightId = Array.isArray(f.flight_id) ? f.flight_id[0] : f.flight_id;
            let time = Array.isArray(f.schedule_time) ? f.schedule_time[0] : f.schedule_time;
            
            // Sjekk retning: A = Arrival, D = Departure
            let direction = Array.isArray(f.arr_dep) ? f.arr_dep[0] : f.arr_dep;

            if (!flightId || !flightId.startsWith("WF")) return; 
            if (BLOCKED_IDS.includes(flightId)) return;

            // Oppdater tid ved status endring
            if (f.status) {
                let statusCode = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.code : (f.status.code || "");
                let statusTime = Array.isArray(f.status) && f.status[0].$ ? f.status[0].$.time : (f.status.time || "");
                if ((statusCode === 'A' || statusCode === 'E' || statusCode === 'D') && statusTime) time = statusTime;
            }

            if (flightId.length > 6) flightId = flightId.substring(0, 6);
            let fromCode = Array.isArray(f.airport) ? f.airport[0] : f.airport;
            const cityName = airportNames[fromCode] || fromCode;

            const flightTime = new Date(time);
            const isToday = flightTime.toDateString() === now.toDateString();
            const minutesDiff = (now - flightTime) / 1000 / 60; // Positiv = Landet siden, Negativ = Frem i tid

            const flightObj = { id: flightId, from: cityName, time: time, dir: direction };

            if (direction === 'A') {
                // --- ANKOMST LOGIKK ---
                if (isToday && minutesDiff > 0) { // Må ha landet
                    if (minutesDiff > ARRIVAL_MIN_AGE && minutesDiff < ARRIVAL_MAX_AGE) {
                        result.arrivals.relevant.push(flightObj);
                    } else {
                        result.arrivals.archive.push(flightObj);
                    }
                }
            } else if (direction === 'D') {
                // --- AVGANG LOGIKK ---
                // Vi vil ønske god tur til de som skal reise SNART.
                // minutesDiff er negativ hvis flyet går i fremtiden.
                // Eks: Fly går om 30 min -> minutesDiff = -30.
                const minutesToTakeoff = -minutesDiff;

                if (isToday && minutesToTakeoff > 0) { // Må være i fremtiden (ikke dratt enda)
                    if (minutesToTakeoff > DEPARTURE_MIN_FUTURE && minutesToTakeoff < DEPARTURE_MAX_FUTURE) {
                        result.departures.relevant.push(flightObj);
                    } else {
                        result.departures.archive.push(flightObj);
                    }
                }
            }
        });

        // Sortering
        result.arrivals.relevant.sort((a, b) => new Date(b.time) - new Date(a.time)); // Nyeste landing først
        result.departures.relevant.sort((a, b) => new Date(a.time) - new Date(b.time)); // Snarligste avgang først

        return result;

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
        console.log(`✅ Data: Arr: ${freshData.arrivals.relevant.length}, Dep: ${freshData.departures.relevant.length}`);
        res.json(freshData);
    } else {
        if (cachedData) res.json(cachedData);
        else res.json({ arrivals: { relevant: [], archive: [] }, departures: { relevant: [], archive: [] } }); 
    }
});

app.listen(PORT, () => console.log(`🚀 Server på port ${PORT}`));

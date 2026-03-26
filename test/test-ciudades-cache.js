require("dotenv").config();

const fs = require("fs");
const path = require("path");

const hgiCacheService = require("../src/services/hgiCacheService");

const CIUDAD_JSON_PATH = path.resolve(__dirname, "../data/ciudad/ciudad.json");

function normalizarCiudadParaCodigo(input) {
  return String(input)
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function cargarCatalogoCodigos() {
  const raw = fs.readFileSync(CIUDAD_JSON_PATH, "utf8");
  const obj = JSON.parse(raw);

  const out = new Map(); // key: ciudad normalizada -> codigo
  for (const [nombre, codigo] of Object.entries(obj)) {
    if (!nombre) continue;
    out.set(normalizarCiudadParaCodigo(nombre), String(codigo));
  }
  return out;
}

async function main() {
  // Asegura que ciudadesMap/fuzzy/cache estén listos
  await hgiCacheService.inicializarCache();

  const catalogo = cargarCatalogoCodigos();
  console.log(`Catalogo ciudades: ${catalogo.size} entradas`);

  const testCasos = [
    // ✅ Bien escritas (exact match directo)
    { input: "MEDELLIN", esperado: "MEDELLIN" },
    { input: "BOGOTA", esperado: "BOGOTA" },
    { input: "CALI", esperado: "CALI" },
    { input: "BARRANQUILLA", esperado: "BARRANQUILLA" },
    { input: "CARTAGENA", esperado: "CARTAGENA" },

    // 🔡 Minúsculas
    { input: "medellin", esperado: "MEDELLIN" },
    { input: "bogota", esperado: "BOGOTA" },
    { input: "cali", esperado: "CALI" },
    { input: "barranquilla", esperado: "BARRANQUILLA" },
    { input: "cartagena", esperado: "CARTAGENA" },

    // 🔀 Mixed case
    { input: "Medellin", esperado: "MEDELLIN" },
    { input: "Bogota", esperado: "BOGOTA" },
    { input: "Bucaramanga", esperado: "BUCARAMANGA" },
    { input: "Santa Marta", esperado: "SANTA MARTA" },
    { input: "Manizales", esperado: "MANIZALES" },

    // 🔤 Con tildes
    { input: "medellín", esperado: "MEDELLIN" },
    { input: "bogotá", esperado: "BOGOTA" },
    { input: "Peréira", esperado: "PEREIRA" },
    { input: "Cúcuta", esperado: "CUCUTA" },
    { input: "Barranquílla", esperado: "BARRANQUILLA" },

    // ✏️ Typos leves (una letra)
    { input: "MEDELIN", esperado: "MEDELLIN" },
    { input: "BOGOT", esperado: "BOGOTA" },
    { input: "BARRANQUILA", esperado: "BARRANQUILLA" },
    { input: "CARTAJENA", esperado: "CARTAGENA" },
    { input: "BUCARAMANGA", esperado: "BUCARAMANGA" },

    // ✏️ Typos doble letra
    { input: "MEDDELLIN", esperado: "MEDELLIN" },
    { input: "CALII", esperado: "CALI" },
    { input: "BOGOTTA", esperado: "BOGOTA" },
    { input: "PERRERIA", esperado: "PEREIRA" },
    { input: "MANIZALLES", esperado: "MANIZALES" },

    // ✏️ Letra faltante
    { input: "ARRANQUILLA", esperado: "BARRANQUILLA" },
    { input: "BUCRAMANGA", esperado: "BUCARAMANGA" },
    { input: "SATA MARTA", esperado: "SANTA MARTA" },
    { input: "CARTAGEN", esperado: "CARTAGENA" },
    { input: "PERIEIRA", esperado: "PEREIRA" },

    // 🔲 Espacios extra
    { input: "  medellin  ", esperado: "MEDELLIN" },
    { input: " bogota ", esperado: "BOGOTA" },
    { input: " Cali ", esperado: "CALI" },
    { input: "  PEREIRA  ", esperado: "PEREIRA" },
    { input: " santa marta ", esperado: "SANTA MARTA" },

    // 💥 Combinados (tilde + typo + case)
    { input: "médellín", esperado: "MEDELLIN" },
    { input: "bógota", esperado: "BOGOTA" },
    { input: "cartájéna", esperado: "CARTAGENA" },
    { input: "Cucutá", esperado: "CUCUTA" },
    { input: "manizálés", esperado: "MANIZALES" },

    // ⚠️ Casos borde
    { input: "MEDELLIN ", esperado: "MEDELLIN" },
    { input: "SANTA  MARTA", esperado: "SANTA MARTA" }, // doble espacio interno
    { input: "Barranquilla ", esperado: "BARRANQUILLA" },
    { input: "CÚCUTÁ", esperado: "CUCUTA" },
    { input: "BUCARAMANGGA", esperado: "BUCARAMANGA" },
  ];

  let ok = 0;
  let fail = 0;

  for (const t of testCasos) {
    const esperadoCodigo =
      catalogo.get(normalizarCiudadParaCodigo(t.esperado)) ?? null;

    if (!esperadoCodigo) {
      console.error("❌ No se pudo determinar esperadoCodigo:", t);
      fail++;
      continue;
    }

    let recibido1;
    let recibido2;
    try {
      console.log(`→ Caso: input=${JSON.stringify(t.input)} esperadoNombre=${JSON.stringify(t.esperado)}`);
      recibido1 = hgiCacheService.obtenerCodigoCiudad(t.input);
      recibido2 = hgiCacheService.obtenerCodigoCiudad(t.input);
    } catch (e) {
      console.error(
        "❌ FAIL:",
        JSON.stringify(t.input),
        "| esperado codigo:",
        esperadoCodigo,
        "| error:",
        e.message,
      );
      fail++;
      continue;
    }

    const pass = recibido1 === esperadoCodigo && recibido2 === esperadoCodigo;
    if (!pass) {
      console.error(
        "❌ FAIL:",
        JSON.stringify(t.input),
        "| esperado codigo:",
        esperadoCodigo,
        "| recibido1:",
        recibido1,
        "| recibido2:",
        recibido2,
      );
      fail++;
      continue;
    }

    console.log(`   OK: input=${JSON.stringify(t.input)} codigo=${recibido1}`);
    ok++;
  }

  console.log(`Resultado: OK=${ok} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();


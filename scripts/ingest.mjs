#!/usr/bin/env node
/**
 * Horizon Bank Strategy Bot – Data Ingestion Pipeline
 * Source documents:
 *   - Hlavní_KPI.docx         (KPI definitions, current & target states)
 *   - Copy_of_KPIs.pdf        (KPI overview)
 *   - Strategický_rámec_banky (Strategic framework, vision, segments, competition)
 *   - Mapovani_regulaci_Tym6  (Regulatory mapping, data products)
 *
 * Usage: npm run ingest
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── YOUR REAL DOCUMENTS ────────────────────────────────────────────────────

const HORIZON_BANK_DOCUMENTS = [

  // ══════════════════════════════════════════════════════════════════════════
  // SOURCE: Hlavní_KPI.docx + Copy_of_KPIs.pdf
  // ══════════════════════════════════════════════════════════════════════════

  {
    content: `Horizon Bank – North Star KPI: NPS (Net Promoter Score)
Definice: Metrika spokojenosti klientů, která měří, jak pravděpodobně by klient doporučil banku svým známým. Hodnocení se získává z klientského průzkumu po interakci nebo pravidelně v aplikaci.
Formát: průměrné hodnocení na škále 1–10.
Počáteční stav: 6,5
Cílový stav: 8,5
Strategický cíl: Být mezi 4 lídry spokojenosti v bankovním sektoru (Air Bank, Raiffeisenbank, Fio Banka, Česká spořitelna) dle průzkumu KPMG 2025.
Proč je důležité: NPS měří spokojenost a důvěru klientů, což je klíčové pro ambici být nejdůvěryhodnější bankou a podporovat dlouhodobý růst.`,
    metadata: { domain: "KPI", source: "Hlavní KPI", tags: ["NPS", "north-star", "spokojenost"] },
  },

  {
    content: `Horizon Bank – North Star KPI: Active Digital Clients
Definice: Podíl klientů, kteří jsou aktivní v digitálním bankovnictví – přihlásí se do aplikace alespoň 5× měsíčně a alespoň 80 % jejich požadavků vyřeší online.
Formát: (aktivní digitální klienti / celkový počet klientů) × 100 %
Počáteční stav: 55 %
Cílový stav: 80 %
Strategický cíl: Aspoň 80 % active digital clients.
Proč je důležité: Vysoký podíl digitálně aktivních klientů je nezbytný pro škálování personalizace, využití AI a snižování provozních nákladů.`,
    metadata: { domain: "KPI", source: "Hlavní KPI", tags: ["digital", "aktivní klienti", "north-star"] },
  },

  {
    content: `Horizon Bank – North Star KPI: Revenue (Výnosy)
Definice: Celkové výnosy banky generované z úroků, poplatků a provizí.
Formát: celkové výnosy (Kč / rok)
Počáteční stav: 2,5 mld. Kč
Cílový stav: 7 mld. Kč ročně za 2 roky, zvyšovat každý rok aspoň o 50 %.
Proč je důležité: Revenue ukazuje schopnost banky efektivně monetizovat klientskou bázi a financovat další růst a inovace.`,
    metadata: { domain: "KPI", source: "Hlavní KPI", tags: ["revenue", "výnosy", "north-star"] },
  },

  {
    content: `Horizon Bank – North Star KPI: Cost-to-Income
Definice: Poměr provozních nákladů banky k jejím výnosům. Měří provozní efektivitu banky.
Formát: (provozní náklady / výnosy) × 100 %
Počáteční stav: 50 %
Cílový stav: 30 %
Proč je důležité: Cost-to-Income měří provozní efektivitu banky a její schopnost dlouhodobě růst udržitelným způsobem.`,
    metadata: { domain: "KPI", source: "Hlavní KPI", tags: ["cost-to-income", "efektivita", "north-star"] },
  },

  {
    content: `Horizon Bank – Podpůrné KPI: Počet nových klientů
Definice: Počet nových klientů, kteří si v daném období založí účet nebo navážou nový obchodní vztah s bankou. KPI měří schopnost banky získávat nové klienty a rozšiřovat klientskou bázi.
Formát: počet klientů / rok
Počáteční stav: 10 000 klientů ročně
Cílový stav: 100 000 klientů ročně`,
    metadata: { domain: "KPI", source: "Podpůrné KPI", tags: ["akvizice", "noví klienti"] },
  },

  {
    content: `Horizon Bank – Podpůrné KPI: Automation Resolution Rate
Definice: Podíl klientských požadavků vyřešených automatizovaně (digitální kanály, chatbot, self-service) bez zásahu bankéře.
Formát: (automaticky vyřešené požadavky / celkové požadavky) × 100 %
Počáteční stav: 40 %
Cílový stav: 80 %

Podpůrné KPI: Digital Onboarding Conversion Rate
Definice: Podíl klientů, kteří dokončí digitální onboarding proces po jeho zahájení. KPI ukazuje efektivitu digitální akviziční cesty.
Formát: (dokončené onboardingy / zahájené onboardingy) × 100 %
Počáteční stav: 35 %
Cílový stav: 60 %`,
    metadata: { domain: "KPI", source: "Podpůrné KPI", tags: ["automatizace", "onboarding", "digital"] },
  },

  {
    content: `Horizon Bank – Podpůrné KPI: Deviation Rate, Cost per Case, Revenue per Client, Average Resolution Time
Deviation rate: podíl nesouladů mezi finančními a klientskými daty (GL vs. klientské zůstatky). Počáteční stav: 5 %, cílový stav: 0,5 %.
Cost per case: průměrné provozní náklady na zpracování jednoho klientského požadavku. Počáteční stav: 1 200 Kč na případ, cílový stav: 700 Kč na případ.
Revenue per client: průměrný roční výnos generovaný jedním klientem. Počáteční stav: 3 000 Kč / klient / rok, cílový stav: 4 500 Kč / klient / rok.
Average Resolution Time: průměrný čas potřebný k vyřešení klientského požadavku. Počáteční stav: 24 hodin, cílový stav: 2 hodiny.`,
    metadata: { domain: "KPI", source: "Podpůrné KPI", tags: ["deviation", "cost", "resolution time"] },
  },

  {
    content: `Horizon Bank – Use-case KPI: DIGI prodej
Loan Production Volume: příjem z procent za úvěry. Počáteční stav: 1 mld. Kč, cílový stav: 4 mld. Kč. Přispívá k Cost-to-Income / Revenue.
Počet nových klientů: Počáteční stav: 10 000, cílový stav: 100 000 ročně.
Digital onboarding conversion rate: jeden z požadavků, který lze automatizovat. Počáteční stav: 35 %, cílový stav: 60 %. Přispívá k Active digital clients.

Use-case KPI: Obsluha klienta
NPS: přímý indikátor spokojenosti klientů s obsluhou a procesy. Počáteční stav: 6,5, cílový stav: 8,5.
Úspora FTE: snižuje provozní náklady díky automatizaci. Počáteční stav: 0 %, cílový stav: 25 %. Přispívá k Cost-to-Income.
Automation resolution rate: počáteční stav: 40 %, cílový stav: 80 %. Přispívá k Active digital clients.
Revenue per Client: počáteční stav: 3 000 Kč, cílový stav: 4 500 Kč. Přispívá k Cost-to-Income / Revenue.`,
    metadata: { domain: "KPI", source: "Use-case KPI", tags: ["DIGI prodej", "obsluha klienta", "FTE"] },
  },

  {
    content: `Horizon Bank – Use-case KPI: Data Governance
Data quality score: kvalitní data snižují náklady na opravy dat, chyby v reportingu a rework analýz. Počáteční stav: 85 %, cílový stav: 98 %. Přispívá k Cost-to-Income.
Úspora FTE: počáteční stav: 0 %, cílový stav: 25 %.

Use-case KPI: Underwriting
Risk-Adjusted Margin (RAM): vygenerované úroky po odečtení provozních nákladů a očekávaných ztrát z rizika. Počáteční stav: 2,5 %, cílový stav: 4 %.
Time-to-Money: doba od přijetí žádosti po skutečné čerpání prostředků klientem. Počáteční stav: 15 dní, cílový stav: 1 den. Přispívá k NPS.
Cost per Memo: náklady na zpracování jednoho úvěrového případu. Počáteční stav: 1 500 Kč, cílový stav: 800 Kč.
Customer Effort Score (CES): počet iterací nutnosti dodávat dokumenty ze strany klienta. Počáteční stav: 6, cílový stav: 9.
Early Warning Hit Rate: procento identifikovaných signálů včasného varování, které vedly k reálné preventivní akci. Počáteční stav: 50 %, cílový stav: 80 %.`,
    metadata: { domain: "KPI", source: "Use-case KPI", tags: ["data governance", "underwriting", "RAM", "risk"] },
  },

  {
    content: `Horizon Bank – Use-case KPI: Investments a Steering
Investments:
Business Growth: objem zprostředkovaných transakcí (M&A/DCM). Počáteční stav: 5 mld. Kč, cílový stav: 10 mld. Kč.
Risk Mitigation: objem nesplacených úvěrů (NPL) v portfoliu. Počáteční stav: 4 %, cílový stav: 2 %.
Customer Conversion Rate: poměr konverze oslovených zákazníků. Počáteční stav: 20 %, cílový stav: 60 %.

Steering:
Deviation rate: odchylka systémů od účetní knihy. Počáteční stav: 5 %, cílový stav: 1 %.
Včasnost: včasnost podání účetní závěrky. Počáteční stav: 85 %, cílový stav: 98 %.
Doba detekce: doba uskutečnění a reálného zaznamenání. Počáteční stav: 3 dny, cílový stav: 1 den.

Risk ESG:
Rizikově vážená aktiva: kolik kapitálu musí banka držet. Počáteční stav: 65 %, cílový stav: 55 %.
RAROC (Rizikově upravená návratnost kapitálu): ziskovost investice po zohlednění rizika. Počáteční stav: 10 %, cílový stav: 20 %.
Zrychlení schvalování hypoték: počáteční stav: 14 dní, cílový stav: 5 dní.`,
    metadata: { domain: "KPI", source: "Use-case KPI", tags: ["investments", "steering", "ESG", "RAROC"] },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SOURCE: Strategický_rámec_banky_copy1.docx
  // ══════════════════════════════════════════════════════════════════════════

  {
    content: `Horizon Bank – Brand, Purpose a Mise
Brand claim: Rosteme spolu.
Purpose: Pomáháme lidem vidět a využít finanční příležitosti ve správný čas.
Mise: Být bankou, která díky datům a AI rozumí životní situaci klienta a proaktivně mu pomáhá využívat finanční příležitosti ve správný čas.
Vize: Stát se nejdůvěryhodnější a nejvíce proaktivní AI-driven bankou na českém trhu.
Základní produktová filozofie: Anticipativní bankovnictví s vysokou mírou personalizace a zároveň jednoduchosti.`,
    metadata: { domain: "Strategický rámec", source: "Strategický rámec banky", tags: ["vize", "mise", "brand", "purpose"] },
  },

  {
    content: `Horizon Bank – Cílové segmenty: Gen Z (18–30 let)
Gen Z představuje strategicky důležitý segment z dlouhodobého hlediska. Tito klienti jsou na začátku své finanční životní dráhy.
Charakteristika: digitálně orientovaná generace, preferuje mobilní bankovnictví a fintech řešení, vysoká otevřenost inovativním bankovním službám.
Více než 70 % Gen Z preferuje správu financí prostřednictvím mobilních aplikací. Až 76 % preferuje mobilní bankovnictví jako hlavní způsob správy financí.
Velikost segmentu: přibližně 2 miliony lidí v ČR.
Finanční potenciál: 864 miliard Kč roční disponibilní příjem, cca 600 miliard Kč bankovní potenciál (úspory, investice, úvěry).
Strategický význam: dlouhodobá hodnota klienta (lifetime value), rychlá adopce digitálních služeb, potenciál růstu investic a úvěrů v průběhu života.`,
    metadata: { domain: "Strategický rámec", source: "Cílové segmenty", tags: ["Gen Z", "segment", "digital", "retail"] },
  },

  {
    content: `Horizon Bank – Cílové segmenty: SME (malé a střední podniky)
Segment SME představuje pro banku klíčovou obchodní příležitost díky vysoké potřebě financování, řízení cashflow a efektivní správy financí.
Charakteristika: firmy s potřebou financování, omezenější finanční rezervy, citlivé cashflow, důraz na rychlost a jednoduchost.
Velikost segmentu: přibližně 1,15 milionu podniků.
Finanční potenciál: 1,6 bilionu Kč bankovního potenciálu.
Market share cíle: krátkodobý (3–5 let): 3–5 % retailového trhu; delší horizont (5–10 let): 5–8 % retailového trhu.
Strategický význam: vysoká potřeba úvěrů, poptávka po automatizaci, prostor pro AI-driven risk a underwriting.`,
    metadata: { domain: "Strategický rámec", source: "Cílové segmenty", tags: ["SME", "segment", "cashflow", "úvěry"] },
  },

  {
    content: `Horizon Bank – Value Proposition a Konkurenční výhody
Value proposition:
1. Personalizovaná finanční doporučení: banka analyzuje data o chování klienta a nabízí řešení šitá na míru (úspory, investice, úvěry).
2. Proaktivní pomoc v důležitých finančních situacích: klient nemusí sám hledat možnosti – banka ho upozorní, když může ušetřit nebo investovat.
3. Úspora času a jednoduchost: finanční správa je jednoduchá, banka filtruje informace a nabízí jen relevantní řešení.
4. Rychlé a digitální procesy: založení účtu, schválení úvěru nebo další služby probíhají rychle a bez zbytečné administrativy.

Konkurenční výhody:
- Finanční nabídky šité na míru
- Digital only
- Rychlost (rychlé schválení úvěrů a hypoték)
- Nižší hypoteční a úvěrové sazby`,
    metadata: { domain: "Strategický rámec", source: "Value Proposition", tags: ["value proposition", "konkurenční výhody", "digital only"] },
  },

  {
    content: `Horizon Bank – Konkurenční prostředí na českém trhu
Největší hráči: Česká spořitelna (4,55 mil. klientů, tržby 56,486 mld. Kč), ČSOB (4,31 mil. klientů, bilanční suma 1,869 bil. Kč), Komerční banka (2,20 mil. klientů).
Air Bank: digitálně orientovaná, 1,2 mil. klientů, nejlepší UX, slabší nabídka pro SME.
Fio banka: 1,4 mil. klientů, nízkonákladový model, kombinace bankovnictví s investicemi.
Raiffeisenbank: 1,8 mil. klientů, silná SME a univerzální nabídka, vyšší komplexita a náklady.

Naše odlišení:
1. AI-driven personalizace: využití AI pro proaktivní finanční doporučení.
2. Digital-first architektura: bankovní infrastruktura navržená od začátku jako digitální.
3. Rychlé rozhodování v úvěrech: využití AI modelů pro underwriting.`,
    metadata: { domain: "Strategický rámec", source: "Konkurenční prostředí", tags: ["konkurence", "Air Bank", "Česká spořitelna", "trh"] },
  },

  {
    content: `Horizon Bank – Organizační struktura a obchodní linie
1. Data & Customer Intelligence (CDO): personalizace služeb, klientská data, zákaznická zkušenost. Týmy: Digi prodej, Obsluha klienta, Data Governance.
2. Technology & AI (CTO): technologická platforma, AI modely, digitální infrastruktura. Týmy: ICM GenAI Data Use Cases, Data Operations & Architecture.
3. Finance & Investment (CFO): finanční řízení, řízení kapitálu, investiční produkty. Týmy: Steering Data, Investment Banking.
4. Risk & Compliance (CRO): úvěrové a tržní riziko, ESG risk, regulatorní compliance. Týmy: Risk ESG, Regulatory & Compliance.

Produkty:
Retail: účty, karty, úvěry, hypotéky, pojištění, FX, investice.
Corporate: účty, úvěry, investice, správa firemní likvidity, AI Investment Advisor.`,
    metadata: { domain: "Strategický rámec", source: "Organizační struktura", tags: ["CDO", "CTO", "CFO", "CRO", "struktura"] },
  },

  {
    content: `Horizon Bank – Kanály pro komunikaci s klientem
Mobilní bankovnictví: hlavní komunikační kanál. Personalizovaná doporučení v reálném čase.
Call centrum: podpůrný kanál pro komplexní problémy.
Email a Push notifikace: proaktivní komunikace – upozornění na finanční příležitosti.
Pobočka: převážně pro corporate klienty. Plánováno 20–30 poboček ve velkých městech (Praha, Brno, Ostrava, Plzeň). Retailní segment obsluhován digitálně.`,
    metadata: { domain: "Strategický rámec", source: "Kanály komunikace", tags: ["mobile", "push notifikace", "pobočky", "omnichannel"] },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // SOURCE: Mapovani_regulaci_Tym6.docx
  // ══════════════════════════════════════════════════════════════════════════

  {
    content: `Horizon Bank – Regulatorní mapování: Vlastní datové produkty (Tým 6 Strategy)
Datové produkty: DP_STRATEGY_MARKET_RATE_SNAPSHOT a DP_STRATEGY_KNOWLEDGE_SNAPSHOT.

BCBS 239: Market Rate Snapshot přispívá ✓ – sazby ČNB, DQ pravidla, lineage Bronze→Gold. Knowledge Snapshot přispívá ✓ – critical_data_element = true, trackovatelné zdroje.
BASEL IV: Market Rate Snapshot přispívá ✓ – referenční tržní data pro výpočty závislé na úrokových sazbách. Knowledge Snapshot N/A – textové dokumenty, nepodílí se na RWA.
EBA Guidelines on data governance: oba produkty přispívají ✓ – data contract (owner, steward, DQ pravidla, sensitivity), DQ skóre monitorováno přes Great Expectations.
DORA: oba produkty obojí ↕ – přístupy řízeny přes Unity Catalog, pravidelná revize oprávnění.
MiFID II: Market Rate Snapshot přispívá ✓ – best-execution analýzy, SLA retence 36 měsíců.
GDPR: oba produkty N/A – gdpr_relevant = false, žádná PII data.`,
    metadata: { domain: "Regulace", source: "Mapování regulací Tým 6", tags: ["BCBS 239", "BASEL IV", "EBA", "DORA", "GDPR", "MiFID II"] },
  },

  {
    content: `Horizon Bank – Regulatorní mapování: AI Act a IFRS 9
AI Act – Umělá inteligence:
Knowledge Snapshot: obojí ↕ – vstupuje do RAG pipeline. Obsah musí být schválený a trackovatelný. High-risk AI systémy vyžadují datovou kvalitu pro trénink modelů a auditovatelnost.
Market Rate Snapshot: N/A – produkt není vstupem do žádného AI/ML systému, slouží pro reporting a dashboardy.

IFRS 9 – Finanční výkaznictví:
Market Rate Snapshot: přispívá ✓ – sazby ČNB jsou referenční data pro finanční výpočty a backtesting ECL modelů. Retence 36 měsíců zajišťuje historickou řadu.
Knowledge Snapshot: N/A – textové dokumenty, nesouvisí s finančním výkaznictvím.`,
    metadata: { domain: "Regulace", source: "Mapování regulací Tým 6", tags: ["AI Act", "IFRS 9", "RAG", "compliance"] },
  },

  {
    content: `Horizon Bank – Regulatorní mapování: Vstupní datové produkty pro Strategy Dashboard
cs_kpi_performance (Tým 3): BCBS 239 – critical_data_element = true, DQ check (not_null, range, freshness). GDPR omezuje ⚠ – pouze agregovaná data, ne event-level data s customer_id.
gl_deviation_snapshot (Tým 4): BCBS 239 – critical_data_element = true, DQ check not_null na DIFF_BAL_CALC. IFRS 9 – obojí ↕, produkt přímo podléhá IFRS 9.
dp_credit_risk_credit_memo_profile (Tým 7): BCBS 239 – outstanding_balance_czk vstup pro Revenue výpočet, freshness D+1. GDPR omezuje ⚠ – Confidential, pouze pro interní výpočet, nesmí být zobrazeno v dashboardu.
DORA (všechny vstupy): omezuje ⚠ – SLA dodavatelů (D+1/T+1) monitorováno přes freshness check v DQ notebooku.
AML: N/A – žádná klientská transakční data, pouze agregovaná KPI, mimo scope AML.`,
    metadata: { domain: "Regulace", source: "Mapování regulací Tým 6", tags: ["dashboard", "datové produkty", "DQ", "BCBS 239", "GDPR", "DORA"] },
  },
];

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkDocument(doc, maxChunkChars = 900) {
  const { content, metadata } = doc;
  const paragraphs = content.split("\n").filter((p) => p.trim().length > 0);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n" + para : para;
    if (candidate.length > maxChunkChars && current.length > 0) {
      chunks.push({ content: current.trim(), metadata });
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push({ content: current.trim(), metadata });
  return chunks;
}

// ─── Embedding Generation ────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
}

// ─── Upsert into Supabase ────────────────────────────────────────────────────

async function upsertChunks(chunks) {
  const { error } = await supabase.from("documents").insert(
    chunks.map((c) => ({
      content: c.content,
      embedding: c.embedding,
      metadata: c.metadata,
    }))
  );
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

async function ingest() {
  console.log("🏦  Horizon Bank RAG – Ingestion Pipeline\n");
  console.log(`📚  Documents loaded: ${HORIZON_BANK_DOCUMENTS.length}`);

  const allChunks = HORIZON_BANK_DOCUMENTS.flatMap((doc) => chunkDocument(doc));
  console.log(`📄  Total chunks after splitting: ${allChunks.length}\n`);

  const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`⚙️   Batch ${batchNum}/${totalBatches} – embedding ${batch.length} chunks...`);

    try {
      const texts = batch.map((c) => c.content);
      const embeddings = await generateEmbeddings(texts);

      const chunksWithEmbeddings = batch.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }));

      await upsertChunks(chunksWithEmbeddings);
      console.log(`✅  Batch ${batchNum} upserted.`);
    } catch (err) {
      console.error(`❌  Batch ${batchNum} failed: ${err.message}`);
      throw err;
    }

    if (i + BATCH_SIZE < allChunks.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log("\n🎉  Ingestion complete. Your real documents are now in Supabase.");
  console.log("\n📊  Chunks ingested by domain:");

  const domains = {};
  allChunks.forEach((c) => {
    const d = c.metadata.domain;
    domains[d] = (domains[d] || 0) + 1;
  });
  Object.entries(domains).forEach(([domain, count]) => {
    console.log(`     ${domain}: ${count} chunks`);
  });
}

ingest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

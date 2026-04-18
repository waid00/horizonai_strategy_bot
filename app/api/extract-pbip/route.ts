/**
 * Extract report definition from Power BI files (.pbip or .pbix)
 * 
 * .pbip files (Power BI Project - newer format):
 *   - report.json - Report definition with pages, visualizations, measures
 *   - model.bim or model.json - Data model definition
 *   - metadata.json and other metadata files
 * 
 * .pbix files (Power BI Desktop - older format):
 *   - DataModelSchema - Contains model metadata
 *   - ComponentIdMapping.json - Maps component IDs
 *   - Other metadata and configuration files
 * 
 * This endpoint:
 * 1. Accepts .pbip or .pbix file upload
 * 2. Extracts it (both are ZIP archives)
 * 3. Finds and parses available JSON/metadata files
 * 4. Returns structured JSON for LLM analysis
 */

import { NextRequest } from "next/server";
import JSZip from "jszip";

export const runtime = "nodejs";

interface ExtractionResult {
  success: boolean;
  reportData?: {
    name: string;
    report?: Record<string, unknown>;
    model?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  error?: string;
  fileInfo?: {
    fileName: string;
    fileSize: number;
    extractedFiles: string[];
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const contentType = req.headers.get("content-type") || "";

    // Handle multipart/form-data
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File;

      if (!file) {
        return Response.json(
          { success: false, error: "No file provided" },
          { status: 400 }
        );
      }

      // Validate file type
      if (!file.name.toLowerCase().endsWith(".pbip") && !file.name.toLowerCase().endsWith(".pbix")) {
        return Response.json(
          {
            success: false,
            error: "File must be a .pbip or .pbix (Power BI) file",
          },
          { status: 400 }
        );
      }

      // Validate file size (max 100MB)
      if (file.size > 100 * 1024 * 1024) {
        return Response.json(
          { success: false, error: "File too large (max 100MB)" },
          { status: 400 }
        );
      }

      console.log(
        `[PBIP] Processing: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
      );

      const arrayBuffer = await file.arrayBuffer();
      const result = await extractJsonFromPowerBi(arrayBuffer, file.name);

      return Response.json(result, {
        status: result.success ? 200 : 400,
      });
    }

    // Handle raw binary upload
    const arrayBuffer = await req.arrayBuffer();
    const fileName = arrayBuffer.byteLength > 0 ? "upload.pbip" : "upload.pbix";
    const result = await extractJsonFromPowerBi(arrayBuffer, fileName);

    return Response.json(result, {
      status: result.success ? 200 : 400,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PBIP] Request failed:", message);
    return Response.json(
      {
        success: false,
        error: `Server error: ${message}`,
      },
      { status: 500 }
    );
  }
}

async function extractJsonFromPowerBi(
  arrayBuffer: ArrayBuffer,
  fileName: string
): Promise<ExtractionResult> {
  try {
    const isPbix = fileName.toLowerCase().endsWith(".pbix");
    const fileType = isPbix ? ".pbix" : ".pbip";
    
    const zip = new JSZip();
    await zip.loadAsync(arrayBuffer);

    const extractedFiles: string[] = [];
    const allZipEntries: string[] = [];
    let reportJson: Record<string, unknown> | null = null;
    let modelJson: Record<string, unknown> | null = null;
    let metadataJson: Record<string, unknown> | null = null;

    // First pass: log all entries to help with debugging
    for (const filePath of Object.keys(zip.files)) {
      if (!zip.files[filePath].dir) {
        allZipEntries.push(filePath);
      }
    }
    console.log(`[PBI] ZIP contains ${allZipEntries.length} files:`, allZipEntries.slice(0, 10).join(", ") + (allZipEntries.length > 10 ? "..." : ""));

    // Iterate through ZIP files looking for JSON files and other extractable content
    for (const [filePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      const lowerPath = filePath.toLowerCase();

      // Extract report definition (.pbip specific)
      if (lowerPath.endsWith("report.json")) {
        try {
          const content = await zipEntry.async("string");
          reportJson = JSON.parse(content);
          extractedFiles.push(filePath);
          console.log(`[PBI] Extracted: ${filePath} (${content.length} bytes)`);
        } catch (err) {
          console.warn(`[PBI] Failed to parse ${filePath}:`, err);
        }
      }

      // Extract data model (.pbip and .pbix)
      if (
        lowerPath.endsWith(".bim") ||
        (lowerPath.includes("model") && lowerPath.endsWith(".json"))
      ) {
        try {
          const content = await zipEntry.async("string");
          modelJson = JSON.parse(content);
          extractedFiles.push(filePath);
          console.log(`[PBI] Extracted: ${filePath} (${content.length} bytes)`);
        } catch (err) {
          console.warn(`[PBI] Failed to parse ${filePath}:`, err);
        }
      }

      // Extract component mapping (.pbix specific)
      if (
        isPbix &&
        lowerPath.includes("componentidmapping") &&
        lowerPath.endsWith(".json")
      ) {
        try {
          const content = await zipEntry.async("string");
          metadataJson = JSON.parse(content);
          extractedFiles.push(filePath);
          console.log(`[PBI] Extracted: ${filePath} (${content.length} bytes)`);
        } catch (err) {
          console.warn(`[PBI] Failed to parse ${filePath}:`, err);
        }
      }

      // Extract metadata files (.pbip specific)
      if (
        !isPbix &&
        lowerPath.includes("metadata") &&
        lowerPath.endsWith(".json")
      ) {
        try {
          const content = await zipEntry.async("string");
          metadataJson = JSON.parse(content);
          extractedFiles.push(filePath);
          console.log(`[PBI] Extracted: ${filePath} (${content.length} bytes)`);
        } catch (err) {
          console.warn(`[PBI] Failed to parse ${filePath}:`, err);
        }
      }

      // Extract any JSON file as potential metadata (.pbix)
      if (
        isPbix &&
        lowerPath.endsWith(".json") &&
        !metadataJson &&
        !reportJson &&
        !modelJson
      ) {
        try {
          const content = await zipEntry.async("string");
          const parsed = JSON.parse(content);
          metadataJson = parsed;
          extractedFiles.push(filePath);
          console.log(`[PBI] Extracted JSON: ${filePath} (${content.length} bytes)`);
        } catch (err) {
          // Silently skip unparseable JSON
        }
      }
    }

    // For .pbix, extract ACTUAL visualization and metric information
    if (isPbix) {
      let visualizationsList: string[] = [];
      let visualizationDetails: Record<string, unknown>[] = [];
      let tablesList: string[] = [];
      let measuresList: string[] = [];
      let columnsList: string[] = [];
      
      // Extract component/visualization names from ComponentIdMapping
      for (const [filePath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;
        const lowerPath = filePath.toLowerCase();
        
        // Parse ComponentIdMapping to get visualization names
        if (lowerPath.includes("componentidmapping") && lowerPath.endsWith(".json")) {
          try {
            const content = await zipEntry.async("string");
            const mapping = JSON.parse(content) as Record<string, any>;
            
            console.log(`[PBI] Found ComponentIdMapping with ${Object.keys(mapping).length} entries`);
            
            for (const [id, component] of Object.entries(mapping)) {
              if (component && typeof component === 'object') {
                // Try multiple name fields
                const vizName = component.name || component.displayName || component.displayname || component.Name || id;
                if (vizName && typeof vizName === 'string') {
                  visualizationsList.push(vizName);
                  visualizationDetails.push({
                    id,
                    name: vizName,
                    type: component.type || component.visualType || "visualization"
                  });
                }
              }
            }
            console.log(`[PBI] Extracted ${visualizationsList.length} visualizations from ComponentIdMapping`);
          } catch (err) {
            console.warn("[PBI] Failed to parse ComponentIdMapping:", err);
          }
        }
        
        // Approach 2: Look for Report.json which might have visualizations
        if (lowerPath.includes("report") && lowerPath.endsWith(".json") && visualizationsList.length === 0) {
          try {
            const content = await zipEntry.async("string");
            const report = JSON.parse(content) as Record<string, any>;
            
            // Look for sections/pages
            if (report.sections && Array.isArray(report.sections)) {
              for (const section of report.sections) {
                if (section.visualizations && Array.isArray(section.visualizations)) {
                  for (const viz of section.visualizations) {
                    const vizName = viz.name || viz.displayName || `Visualization ${visualizationsList.length + 1}`;
                    visualizationsList.push(vizName);
                    visualizationDetails.push({
                      name: vizName,
                      type: viz.visualType || "chart"
                    });
                  }
                }
              }
            }
            
            if (visualizationsList.length > 0) {
              console.log(`[PBI] Extracted ${visualizationsList.length} visualizations from Report.json`);
            }
          } catch (err) {
            // Silently skip
          }
        }
        
        // Parse data model for tables, measures, columns
        if ((lowerPath.includes("datamodelschema") || 
             (lowerPath.includes("model") && lowerPath.endsWith(".json"))) && 
            !modelJson) {
          try {
            const content = await zipEntry.async("string");
            const model = JSON.parse(content) as Record<string, any>;
            modelJson = model;
            
            if (model.tables && Array.isArray(model.tables)) {
              for (const table of model.tables) {
                const tableName = table.name || table.Name || "Unknown";
                tablesList.push(tableName);
                
                if (table.measures && Array.isArray(table.measures)) {
                  for (const measure of table.measures) {
                    measuresList.push(`${tableName}.${measure.name || measure.Name}`);
                  }
                }
                
                if (table.columns && Array.isArray(table.columns)) {
                  for (const column of table.columns) {
                    columnsList.push(`${tableName}.${column.name || column.Name}`);
                  }
                }
              }
            }
            console.log(`[PBI] Extracted ${tablesList.length} tables, ${measuresList.length} measures, ${columnsList.length} columns`);
          } catch (err) {
            console.warn("[PBI] Failed to parse data model:", err);
          }
        }
      }
      
      // Return structured extraction with ACTUAL extracted data
      const extractedReport = {
        fileFormat: ".pbix (Power BI Desktop)",
        fileSizeKB: (arrayBuffer.byteLength / 1024).toFixed(2),
        extractedVisualizations: {
          count: visualizationsList.length,
          list: visualizationsList.slice(0, 50),
          details: visualizationDetails.slice(0, 50)
        },
        extractedDataModel: {
          tables: tablesList,
          measures: measuresList.slice(0, 100),
          columns: columnsList.slice(0, 100),
        },
        summary: `Found ${visualizationsList.length} visualizations, ${tablesList.length} data tables, ${measuresList.length} measures, ${columnsList.length} columns`,
        debugInfo: {
          jsonFilesFound: allZipEntries.filter(f => f.toLowerCase().endsWith('.json')).length,
          jsonFiles: allZipEntries.filter(f => f.toLowerCase().endsWith('.json')).slice(0, 20)
        }
      };
      
      console.log(`[PBI] Final extraction summary: ${extractedReport.summary}`);
      
      return {
        success: true,
        reportData: {
          name: fileName,
          report: extractedReport,
          model: modelJson || undefined,
          metadata: { visualizations: visualizationsList, details: visualizationDetails },
        },
        fileInfo: {
          fileName,
          fileSize: arrayBuffer.byteLength,
          extractedFiles: allZipEntries,
        },
      };
    }

    if (!reportJson && !modelJson && !metadataJson) {
      return {
        success: false,
        error: `No extractable data found in ${fileType}. Found files: ${allZipEntries.slice(0, 20).join(", ")}`,
      };
    }

    console.log(
      `[PBI] Successfully extracted ${extractedFiles.length} file(s) from ${fileType}`
    );

    return {
      success: true,
      reportData: {
        name: fileName,
        report: reportJson || undefined,
        model: modelJson || undefined,
        metadata: metadataJson || undefined,
      },
      fileInfo: {
        fileName,
        fileSize: arrayBuffer.byteLength,
        extractedFiles,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PBI] Extraction failed:", message);
    return {
      success: false,
      error: `Failed to extract Power BI file: ${message}`,
    };
  }
}

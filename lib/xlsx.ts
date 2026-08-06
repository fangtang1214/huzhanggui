import { strToU8, unzipSync, zipSync } from "fflate";

type Column = { header: string; key: string; width?: number };
type Row = Record<string, unknown>;

function escapeXml(value: unknown) {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function columnName(index: number) {
  let value = index + 1; let output = "";
  while (value > 0) { value -= 1; output = String.fromCharCode(65 + (value % 26)) + output; value = Math.floor(value / 26); }
  return output;
}

export function createXlsx(sheetName: string, columns: Column[], rows: Row[]) {
  const safeName = sheetName.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || "数据";
  const headerCells = columns.map((column, index) => `<c r="${columnName(index)}1" t="inlineStr" s="1"><is><t>${escapeXml(column.header)}</t></is></c>`).join("");
  const dataRows = rows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 2}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(row[column.key])}</t></is></c>`).join("");
    return `<row r="${rowIndex + 2}">${cells}</row>`;
  }).join("");
  const widths = columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.max(10, Math.min(50, column.width || 16))}" customWidth="1"/>`).join("");
  const lastColumn = columnName(Math.max(0, columns.length - 1));
  const lastRow = Math.max(1, rows.length + 1);

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315E52"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData><row r="1" ht="26" customHeight="1">${headerCells}</row>${dataRows}</sheetData><autoFilter ref="A1:${lastColumn}1"/></worksheet>`),
  };
  return zipSync(files, { level: 6 });
}

type DataValidation = { column: number; type: "list"; formula1: string };

export function createImportTemplate(sheets: Array<{ name: string; columns: Column[]; rows: Row[]; validations?: DataValidation[] }>) {
  const files: Record<string, Uint8Array> = {};
  const sheetNames: string[] = [];
  const contentTypes: string[] = [];
  const workbookSheets: string[] = [];
  const relParts: string[] = [];

  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    const safeName = sheet.name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31);
    const sheetId = i + 1;
    sheetNames.push(safeName);
    const sheetRId = `rId${sheetId}`;

    const headerCells = sheet.columns.map((column, index) => `<c r="${columnName(index)}1" t="inlineStr" s="1"><is><t>${escapeXml(column.header)}</t></is></c>`).join("");
    const dataRows = sheet.rows.map((row, rowIndex) => {
      const cells = sheet.columns.map((column, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 2}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(row[column.key])}</t></is></c>`).join("");
      return `<row r="${rowIndex + 2}">${cells}</row>`;
    }).join("");
    const widths = sheet.columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.max(10, Math.min(50, column.width || 16))}" customWidth="1"/>`).join("");
    const lastColumn = columnName(Math.max(0, sheet.columns.length - 1));
    const lastRow = Math.max(1, sheet.rows.length + 1);

    let dataValidations = "";
    if (sheet.validations && sheet.validations.length > 0) {
      const dvParts = sheet.validations.map((dv) => {
        const col = columnName(dv.column);
        return `<dataValidation type="${dv.type}" allowBlank="true" showErrorMessage="true" sqref="${col}2:${col}${Math.max(2, lastRow + 100)}"><formula1>${escapeXml(dv.formula1)}</formula1></dataValidation>`;
      });
      dataValidations = `<dataValidations count="${dvParts.length}">${dvParts.join("")}</dataValidations>`;
    }

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData><row r="1" ht="26" customHeight="1">${headerCells}</row>${dataRows}</sheetData>${dataValidations}<autoFilter ref="A1:${lastColumn}1"/></worksheet>`;

    const fileKey = `xl/worksheets/sheet${sheetId}.xml`;
    files[fileKey] = strToU8(sheetXml);

    contentTypes.push(`<Override PartName="/${fileKey}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    workbookSheets.push(`<sheet name="${escapeXml(safeName)}" sheetId="${sheetId}" r:id="${sheetRId}"/>`);
    relParts.push(`<Relationship Id="${sheetRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetId}.xml"/>`);
  }

  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypes.join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets.join("")}</sheets></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${relParts.join("")}</Relationships>`);
  files["xl/styles.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315E52"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);

  return zipSync(files, { level: 6 });
}

export function parseXlsxRows(data: Uint8Array): string[][] {
  const files = unzipSync(data);
  const sheetPath = Object.keys(files).find((k) => k.startsWith("xl/worksheets/sheet") && !k.includes("sheet1."));
  const sheetXml = strFromU8(files[sheetPath || "xl/worksheets/sheet1.xml"]);
  const rows: string[][] = [];
  const re = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c[^>]*>(?:<is>[\s\S]*?<t[\s\S]*?>([\s\S]*?)<\/t>[\s\S]*?<\/is>|<v>([^<]*)<\/v>)<\/c>/g;
  let rowMatch;
  while ((rowMatch = re.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const cells: string[] = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowContent)) !== null) {
      cells.push((cellMatch[1] || cellMatch[2] || "").trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function strFromU8(data: Uint8Array) {
  return new TextDecoder().decode(data);
}

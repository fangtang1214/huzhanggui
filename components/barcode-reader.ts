import { BarcodeFormat, BrowserMultiFormatReader } from "@zxing/browser";

let readerInstance: BrowserMultiFormatReader | null = null;

export function getBarcodeReader() {
  if (!readerInstance) {
    readerInstance = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 500 });
    readerInstance.possibleFormats = [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE];
  }
  return readerInstance;
}

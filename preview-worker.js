import { parentPort, workerData } from 'node:worker_threads';

// Office conversion stays local and cannot block the application's event loop.
try {
  if(workerData.ext==='.docx'){
    const {default:mammoth}=await import('mammoth');
    const result=await mammoth.extractRawText({path:workerData.filename});
    parentPort.postMessage({kind:'text',text:result.value.slice(0,200000),truncated:result.value.length>200000,note:'Word 正文预览；不保留原文档版式'});
  }else{
    const {default:ExcelJS}=await import('exceljs');
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workerData.filename);
    const sheets=workbook.worksheets.slice(0,10).map(sheet=>{
      const rows=[];
      for(let i=1;i<=Math.min(sheet.rowCount,200);i++){
        const row=sheet.getRow(i),cells=[];
        for(let j=1;j<=Math.min(sheet.columnCount,30);j++)cells.push(String(row.getCell(j).text||'').slice(0,2000));
        rows.push(cells);
      }
      return {name:sheet.name,rows,truncated:sheet.rowCount>200||sheet.columnCount>30};
    });
    parentPort.postMessage({kind:'spreadsheet',sheets,truncated:workbook.worksheets.length>10,note:'表格内容预览；最多 10 个工作表，每表 200 行、30 列，不执行公式或宏'});
  }
}catch{parentPort.postMessage({error:'文件无法预览，请下载后打开'});}

import { diagnoseGemini } from '../src/agent/gemini-diagnostics.js';

const report = await diagnoseGemini({
  key: process.env.GEMINI_API_KEY ?? '',
  inference: process.argv.includes('--infer'),
});
console.log(JSON.stringify(report, null, 2));
if (
  report.discovery.httpStatus !== 200 ||
  report.discovery.requiredModelListed !== true ||
  (report.inference && report.inference.httpStatus !== 200)
)
  process.exitCode = 1;

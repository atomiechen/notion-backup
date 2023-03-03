#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */

let axios = require('axios')
  , extract = require('extract-zip')
  , { retry } = require('async')
  , { createWriteStream, mkdirSync, rmdirSync, rmSync } = require('fs')
  , { join } = require('path')
  , notionAPI = 'https://www.notion.so/api/v3'
  , { NOTION_TOKEN, NOTION_SPACE_ID } = process.env
  , client = axios.create({
      baseURL: notionAPI,
      headers: {
        Cookie: `token_v2=${NOTION_TOKEN}`
      },
    })
  , die = (str) => {
      console.error(str);
      process.exit(1);
    }
;

if (!NOTION_TOKEN || !NOTION_SPACE_ID) {
  die(`Need to have both NOTION_TOKEN and NOTION_SPACE_ID defined in the environment.
See https://medium.com/@arturburtsev/automated-notion-backups-f6af4edc298d for
notes on how to get that information.`);
}

let timeout = -1;  // in seconds, default: no timeout
let waitcount = 5;  // default: 5 times
const argsObj = {}
process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.split('=')
    // check if not empty strings, and if value is a number
    if (key !== '' && value !== '' && !isNaN(value)) {
        argsObj[key] = Number(value)
    }
})
if ('--timeout' in argsObj) {
  timeout = argsObj['--timeout'] * 1000
}
if ('--waitcount' in argsObj) {
  waitcount = argsObj['--waitcount']
}

async function post (endpoint, data) {
  return client.post(endpoint, data);
}

async function sleep (seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

// formats: markdown, html
async function exportFromNotion (format, timeout, waitcount) {
  // try {
    let startTime = Date.now();
    console.log("Start exporting as " + format)
    if (timeout > 0) {
      console.log("Set timeout: " + timeout/1000 + "s")
    }
    let { data: { taskId } } = await post('enqueueTask', {
      task: {
        eventName: 'exportSpace',
        request: {
          spaceId: NOTION_SPACE_ID,
          exportOptions: {
            exportType: format,
            timeZone: 'America/New_York',
            locale: 'en',
          },
        },
      },
    });
    console.warn(`Enqueued task ${taskId}`);
    let failCount = 0
      , exportURL
      , export_num = 0
      , export_stuck = 0
    ;
    while (true) {
      if (timeout > 0 && Date.now() - startTime > timeout) {
        throw new Error("timeout reached: " + timeout/1000 + "s");
      }
      if (failCount >= waitcount) {
        throw new Error("fail count >= " + waitcount);
        // break;
      }
      await sleep(10);
      let { data: { results: tasks } } = await retry(
        { times: 3, interval: 2000 },
        async () => post('getTasks', { taskIds: [taskId] })
      );
      let task = tasks.find(t => t.id === taskId);
      // console.warn(JSON.stringify(task, null, 2)); // DBG
      if (!task) {
        failCount++;
        console.warn(`No task, waiting.`);
        continue;
      }
      if (!task.status) {
        failCount++;
        console.warn(`No task status, waiting. Task was:\n${JSON.stringify(task, null, 2)}`);
        continue;
      }
      if (task.state === 'in_progress') {
        if (export_num === task.status.pagesExported) {
          export_stuck++;
        } else {
          export_stuck = 0;
        }
        if (export_stuck === 5) {
          throw new Error(`Stuck ${export_stuck} times`);
        }
        export_num = task.status.pagesExported;
        console.warn(`Pages exported: ${export_num}`);
      }
      if (task.state === 'failure') {
        failCount++;
        console.warn(`Task error: ${task.error}`);
        continue;
      }
      if (task.state === 'success') {
        exportURL = task.status.exportURL;
        console.log("Task succeeds!");
        break;
      }
    }
    let res = await client({
      method: 'GET',
      url: exportURL,
      responseType: 'stream'
    });
    let stream = res.data.pipe(createWriteStream(join(process.cwd(), `${format}.zip`)));
    await new Promise((resolve, reject) => {
      stream.on('close', () => {
        console.log(`Downloaded: ${format}.zip`);
        resolve();
      });
      stream.on('error', reject);
    });
  // }
  // catch (err) {
  //   die(err);
  // }
}

async function backup(format, timeout, waitcount) {
  let cwd = process.cwd()
    , pathDir = join(cwd, format)
    , pathFile = join(cwd, `${format}.zip`)
  ;
  return exportFromNotion(format, timeout, waitcount).then(() => {
    // rmdirSync(pathDir, { recursive: true });
    rmSync(pathDir, { recursive: true, force: true });
    mkdirSync(pathDir, { recursive: true });
    console.log(`Emptied: ${pathDir}`)
    return extract(pathFile, { dir: pathDir }).then(() => console.log(`Extracted ${pathFile} to ${pathDir}`));
  });
}

async function run () {
  let errorCount = 0;
  await backup('markdown', timeout, waitcount).catch(err => {
    console.log(err);
    errorCount++;
  });
  await backup('html', timeout, waitcount).catch(err => {
    console.log(err);
    errorCount++;
  });
  console.log("done.");
  if (errorCount === 2) {  // all backup tasks failed
    die("All backup tasks failed.");
  }
}

run();

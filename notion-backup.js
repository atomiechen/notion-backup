#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */

let axios = require('axios')
  , extract = require('extract-zip')
  , { retry } = require('async')
  , { createWriteStream } = require('fs')
  , { mkdir, rm, readdir } = require('fs/promises')
  , { join } = require('path')
  , notionAPI = 'https://www.notion.so/api/v3'
  , { NOTION_TOKEN, NOTION_FILE_TOKEN, NOTION_SPACE_ID } = process.env
  , client = axios.create({
      baseURL: notionAPI,
      headers: {
        Cookie: `token_v2=${NOTION_TOKEN}; file_token=${NOTION_FILE_TOKEN}`
      },
    })
  , die = (str) => {
      console.error(str);
      process.exit(1);
    }
;

if (!NOTION_TOKEN || !NOTION_FILE_TOKEN || !NOTION_SPACE_ID) {
  die(`Need to have NOTION_TOKEN, NOTION_FILE_TOKEN and NOTION_SPACE_ID defined in the environment.
See https://github.com/darobin/notion-backup/blob/main/README.md for
a manual on how to get that information.`);
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
    if (waitcount > 0) {
      console.log("Set stuck wait count: " + waitcount)
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
      if (failCount >= 5) {
        throw new Error("fail count >= 5");
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
        if (export_stuck === waitcount) {
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

async function extractZipRecursively(zipFilePath, extractToDir) {
  return extract(zipFilePath, { dir: extractToDir }).then(() => {
    console.log(`Extracted ${zipFilePath} to ${extractToDir}`);
    // delete this zip file
    unlinkSync(zipFilePath);

    const contents = readdirSync(extractToDir);
    const subDirectories = contents.filter((item) => {
      return statSync(join(extractToDir, item)).isDirectory();
    });
    const zipFiles = contents.filter((item) => {
      return extname(item).toLowerCase() === '.zip';
    });
    if (zipFiles.length === 0 && subDirectories.length === 1) {
      // If there are no more zip files in the directory and there is only one subdirectory,
      // return the path to the subdirectory as the final extracted path
      return join(extractToDir, subDirectories[0]);
    } else if (zipFiles.length === 1 && subDirectories.length === 0) {
      // If there is only one zip file in the directory and there are no subdirectories,
      // recursively extract the zip file
      const nextZipFilePath = join(extractToDir, zipFiles[0]);
      const nextExtractToDir = join(extractToDir, parse(nextZipFilePath).name);
      return extractZipRecursively(nextZipFilePath, nextExtractToDir);
    } else {
      throw new Error(`Unexpected file structure in ${extractToDir}`);
    }
  });
}

async function backup(format, timeout, waitcount) {
  let cwd = process.cwd()
    , pathDir = join(cwd, format)
    , pathFile = join(cwd, `${format}.zip`)
  ;
  await exportFromNotion(format, timeout, waitcount);
  await rm(pathDir, { recursive: true, force: true });
  await mkdir(pathDir, { recursive: true });
  console.log(`Emptied: ${pathDir}`);
  await extract(pathFile, { dir: pathDir });
  await extractInnerZip(pathDir);
}

async function run() {
  let errorCount = 0;
  await backup('markdown', timeout, waitcount).catch(err => {
    console.error(err);
    errorCount++;
  });
  await backup('html', timeout, waitcount).catch(err => {
    console.error(err);
    errorCount++;
  });
  console.log("done.");
  if (errorCount === 2) {  // all backup tasks failed
    die("All backup tasks failed.");
  }
}

async function extractInnerZip (dir) {
  let files = (await readdir(dir)).filter(fn => /Part-\d+\.zip$/i.test(fn));
  for (let file of files) {
    await extract(join(dir, file), { dir });
  }
}

run();

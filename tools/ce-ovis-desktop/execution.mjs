import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function requireRunning({root,end,stopped}) {
  if (stopped() || Date.now() >= end || fs.existsSync(path.join(root,'stop-request'))) throw Error('WINDOW_STOPPED');
}

export function runDesktop({python,bridge,task,env,window}) {
  requireRunning(window);
  return new Promise((resolve,reject) => {
    const child=spawn(python,[bridge,'--config',task.desktopConfig,'--task',task.taskFile],{env:{...env,CE_BRIDGE_PARENT_PID:String(process.pid),CE_BRIDGE_STOP_FILE:path.join(window.root,'stop-request')},stdio:['ignore','pipe','ignore']});
    let stdout='';
    let failure;
    const cancel=reason => {failure ??= reason; child.kill('SIGTERM');};
    const limit=Math.min(window.end,Date.now()+300_000);
    const monitor=setInterval(() => {
      try {requireRunning(window); if(Date.now()>=limit) cancel('DESKTOP_DEADLINE');}
      catch {cancel('WINDOW_STOPPED');}
    },50);
    child.stdout.on('data',bytes=>{stdout+=bytes; if(stdout.length>1_048_576) cancel('DESKTOP_OUTPUT_LIMIT');});
    child.on('error',error=>{clearInterval(monitor);reject(error);});
    child.on('close',code=>{
      clearInterval(monitor);
      if(failure || code!==0) reject(Error(failure ?? 'DESKTOP_SCRIPT_FAILED'));
      else {try {requireRunning(window);resolve(stdout);} catch(error){reject(error);}}
    });
  });
}

import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { unwrap } from "../src/policy/command-words";
import { inlineCodeWrites } from "../src/policy/inline-code";
import { classifyCommand, type RiskContext } from "../src/policy/risk";
import { gitWrites, toolWrites } from "../src/policy/write-tools";

/**
 * The command a wrapper, `sudo` or `eval` runs is classified, and so are the files that tools, git
 * and interpreter one-liners write through their own arguments.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
};
const ps: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  shell: "powershell",
};

const levels = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const asksAtBoth = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("auto/full");
};
const neverAsks = (commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe("-/-");
};

describe("wrappers", () => {
  it("classifies the command a wrapper runs", () => {
    asksAtBoth([
      "timeout 9 bash -c 'rm -rf /other'",
      "timeout 5 rm -rf /home/me/p",
      "timeout -s KILL 9 rm -rf /other",
      "timeout --signal=KILL -k 5 9 rm -rf /other",
      "/usr/bin/timeout 5 /bin/rm -rf /home/me/p",
      "nice rm -rf /other",
      "nice -n 5 rm -rf /home/me/p",
      "nice -10 rm -rf /other",
      "nohup rm -rf /other",
      "stdbuf -oL rm -rf /other",
      "stdbuf -o0 cp a /home/me/b",
      "stdbuf -o L -e0 rm -rf /other",
      "ionice -c 3 rm -rf /other",
      "ionice -c3 -n 7 rm -rf /other",
      "time rm -rf /other",
      "time -p rm -rf /other",
      "command rm -rf /other",
      "command -p rm -rf /other",
      "builtin cd /other && git clean -fdx",
      "exec rm -rf /other",
      "exec -a x rm -rf /other",
      "busybox rm -rf /home/me/p",
      "/usr/bin/env FOO=1 rm -rf /home/me/p",
      "timeout 9 nice nohup bash -c 'cd /other && git clean -fdx'",
      "timeout 9 bash -c 'cat /home/me/.agent-rishi/install.json'",
    ]);
  });

  it("skips every sudo option and classifies the command", () => {
    asksAtBoth([
      "sudo rm -rf /home/me/p",
      "sudo -u root rm -rf ~/projects",
      "sudo -n -E rm -rf /home/me/p",
      "sudo -nE -u root -g wheel rm -rf /home/me/p",
      "sudo --user=root --group wheel -- rm -rf /home/me/p",
      "sudo -C 3 -h host -p prompt -T 5 -r role -t type rm -rf /home/me/p",
      "/usr/bin/sudo rm -rf /home/me/p",
      "sudo -D /other git clean -fdx",
      "doas -u root rm -rf /home/me/p",
      "sudo timeout 5 sudo -u me rm -rf /home/me/p",
      "sudo FOO=1 env BAR=2 rm -rf /home/me/p",
    ]);
    expect(unwrap(["sudo", "-u", "root", "-n", "rm", "-rf", "x"])).toMatchObject({
      tokens: ["rm", "-rf", "x"],
      elevated: true,
    });
    expect(unwrap(["/usr/bin/sudo", "-D", "/srv", "make"])).toMatchObject({
      tokens: ["make"],
      chdir: ["/srv"],
    });
    expect(unwrap(["command", "-v", "git"]).tokens).toEqual(["command", "-v", "git"]);
    expect(unwrap(["timeout"]).tokens).toEqual(["timeout"]);
  });

  it("still asks for elevation at Auto only, and leaves ordinary wrapped commands alone", () => {
    for (const command of ["sudo -n true", "sudo apt-get install jq", "sudo -u me ls", "sudo -v"]) {
      expect(levels(command), command).toBe("auto/-");
    }
    neverAsks([
      "timeout 60 pnpm test",
      "time pnpm build",
      "nice -n 10 pnpm build",
      "nohup pnpm dev > /tmp/dev.log 2>&1 &",
      "command -v git",
      "exec > /tmp/out.log 2>&1",
      "stdbuf -oL pnpm test | tee /tmp/test.log",
      "timeout 5 rm -rf ./dist /tmp/scratch",
      "cd /other && timeout 5 git log",
    ]);
  });
});

describe("eval and Invoke-Expression", () => {
  it("classifies a literal string like an inline script", () => {
    asksAtBoth([
      'eval "rm -rf /other"',
      "eval 'rm -rf /home/me/p'",
      "eval rm -rf /other",
      "eval 'cd /other; git clean -fdx'",
      "eval \"eval 'rm -rf /other'\"",
      "timeout 5 eval 'rm -rf /other'",
    ]);
    asksAtBoth(
      [
        'Invoke-Expression "Remove-Item -Recurse -Force C:\\other"',
        "iex 'Remove-Item -Recurse -Force C:\\other'",
        "iex -Command 'Remove-Item -Recurse -Force C:\\other'",
        "iex -Command:'Remove-Item -Recurse -Force C:\\other'",
        "'Remove-Item -Recurse C:\\other' | iex",
        "iex 'if (1) { Remove-Item -Recurse C:\\other }'",
      ],
      ps,
    );
    neverAsks(['eval "git status"', "eval 'pnpm test && rm -rf ./dist'"]);
  });

  it("follows a folder change in the string, and asks for nesting too deep to read", () => {
    asksAtBoth(["eval 'cd ..'; git clean -fdx", "eval 'cd /other'; rm -rf build"]);
    asksAtBoth(["iex 'cd ..'; git clean -fdx"], ps);
    neverAsks(["eval 'cd packages/x'; rm -rf dist"]);
    asksAtBoth(["eval eval eval eval eval rm -rf /other", "eval eval eval eval eval git status"]);
  });

  it("asks for a string that is only known when it runs, unless it only reads", () => {
    for (const command of ['eval "$CMD"', 'eval "$(cat script.sh)"', "eval `cat script.sh`"]) {
      expect(levels(command), command).toBe("auto/-");
    }
    for (const command of ["iex $cmd", "iex (Get-Content x.ps1 -Raw)", "Get-Content x.ps1 | iex"]) {
      expect(levels(command, ps), command).toBe("auto/-");
    }
    expect(classifyCommand('eval "$CMD"', posix)).toMatchObject({
      reason: "Runs a command that is only known when it runs (eval)",
    });
    neverAsks(['eval "git log $REF"', "eval 'ls $DIR'"]);
    expect(levels("iex 'Get-ChildItem $dir'", ps)).toBe("-/-");
    // The part that is written out still counts.
    expect(levels('eval "rm -rf /other/$NAME"')).toBe("auto/full");
  });
});

describe("tools that write through their operands", () => {
  it("asks for a write outside the worktree", () => {
    asksAtBoth([
      "dd if=/dev/zero of=/home/me/disk.img bs=1M count=1",
      "ln -s a /home/me/link",
      "ln -sf a b -t /home/me",
      "chmod -R 777 /home/me/p",
      "chown -R me:me /home/me/p",
      "chgrp staff /home/me/p",
      "chmod --reference=a /home/me/p",
      "sed -i 's/a/b/' /home/me/x.txt",
      "sed -i.bak -e 's/a/b/' /home/me/x.txt",
      "sed --in-place 's/a/b/' ../x.txt",
      "truncate -s 0 /home/me/x.log",
      "install -m 755 a /home/me/bin/a",
      "unzip a.zip -d /home/me/x",
      "sudo chown -R me /home/me/p",
    ]);
    expect(classifyCommand("ln -s a /home/me/.agent-rishi/x", posix)).toMatchObject({
      agentRishi: true,
    });
  });

  it("leaves the same tools alone inside the worktree and temp folders", () => {
    neverAsks([
      "dd if=a of=./b",
      "dd if=/dev/zero of=/tmp/disk.img bs=1M count=1",
      "ln -s a ./b",
      "ln -s /home/me/target ./b",
      "ln -s ../a",
      "chmod +x scripts/run.sh",
      "chmod -R u+w node_modules /tmp/build",
      "sed -i 's/a/b/' src/a.ts",
      "sed -n '1,5p' /home/me/x.txt",
      "sed 's/a/b/' /home/me/x.txt",
      "truncate -s 0 ./x.log",
      "rsync -a src/ /tmp/copy/",
    ]);
  });

  it("reads the option shapes of the write tools", () => {
    asksAtBoth([
      "ln -st /other a",
      "chmod -w /other/x",
      "chmod -R -x /other",
      "perl -pi -e 's/a/b/' /other/x",
      "perl -i.bak -pe 's/a/b/' /other/x",
      "ruby -i -pe 'gsub(/a/, \"b\")' /other/x",
    ]);
    neverAsks([
      "chmod -x scripts/run.sh",
      "sed -ie '/foo/d' src/x.ts",
      "perl -pi -e 's|/usr/local|/opt|' src/x.ts",
      "perl -ne 'print if /foo/' /etc/hosts",
    ]);
    neverAsks(["iex 'git status'", "iex 'Remove-Item -Recurse .\\dist'"], ps);
  });

  it("reads each tool's operands", () => {
    expect(toolWrites("ln", ["-s", "a", "b"])).toEqual(["b"]);
    expect(toolWrites("ln", ["-s", "a"])).toEqual([]);
    expect(toolWrites("chmod", ["-R", "755", "a", "b"])).toEqual(["a", "b"]);
    expect(toolWrites("sed", ["-i", "s/a/b/", "x", "y"])).toEqual(["x", "y"]);
    expect(toolWrites("sed", ["-i", "-e", "s/a/b/", "x"])).toEqual(["x"]);
    expect(toolWrites("sed", ["s/a/b/", "x"])).toEqual([]);
    expect(toolWrites("rsync", ["-a", ".", "host:/srv"])).toEqual([]);
  });
});

describe("git writing outside its repository", () => {
  it("asks for a destination outside the worktree", () => {
    asksAtBoth([
      "git clone https://example.com/a/b /home/me/b",
      "git clone --depth 1 -b main https://example.com/a/b /home/me/b",
      "git -c core.autocrlf=false clone https://example.com/a/b ../b",
      "git worktree add /home/me/wt",
      "git worktree add -b x ../wt main",
      "git diff --output=/home/me/d.patch",
      "git diff --output /home/me/d.patch",
      "git log -p --output=/home/me/log.txt",
      "git format-patch -o /home/me/patches HEAD~2",
      "git format-patch --output-directory=/home/me/patches HEAD~2",
      "git archive -o /home/me/a.tar HEAD",
      "git archive --output=/home/me/a.tar HEAD",
      "git init /home/me/new",
    ]);
  });

  it("leaves destinations inside the worktree alone", () => {
    neverAsks([
      "git clone https://example.com/a/b ./sub",
      "git clone https://example.com/a/b",
      "git clone https://example.com/a/b /tmp/b",
      "git worktree add ./wt",
      "git diff --output=d.patch",
      "git format-patch -o patches HEAD~2",
      "git archive --output=a.tar HEAD",
      "git log --oneline -5",
      "git diff HEAD~1 -- src",
    ]);
    expect(gitWrites(["-C", "x", "clone", "-b", "main", "url", "dest"])).toEqual(["dest"]);
    expect(gitWrites(["status"])).toEqual([]);
  });
});

describe("interpreter one-liners", () => {
  it("asks when the code writes or deletes and names a path outside the worktree", () => {
    asksAtBoth([
      "python -c \"import os; os.remove('/home/me/x')\"",
      "python3 -c \"import shutil; shutil.rmtree('/home/me/p')\"",
      "python -c \"open('/home/me/x','w').write('hi')\"",
      "python -c \"import pathlib; pathlib.Path('~/x').expanduser().unlink()\"",
      "node -e \"require('fs').rmSync('/home/me/p',{recursive:true})\"",
      "node -e \"require('fs').writeFileSync('/home/me/x','hi')\"",
      "node --eval \"require('fs').unlinkSync('/home/me/x')\"",
      "perl -e 'unlink \"/home/me/x\"'",
      "perl -e 'open(F, \">/home/me/x\"); print F 1'",
      "ruby -e 'File.delete(\"/home/me/x\")'",
      "php -r 'unlink(\"/home/me/x\");'",
      "timeout 5 python -c \"import os; os.remove('/home/me/x')\"",
    ]);
    asksAtBoth(
      [
        "python -c \"import os; os.remove('C:\\\\Users\\\\me\\\\x')\"",
        "node -e \"require('fs').rmSync('C:/Users/me/p')\"",
      ],
      ps,
    );
    const home = "node -e \"require('fs').writeFileSync('/home/me/.agent-rishi/x','hi')\"";
    expect(classifyCommand(home, posix)).toMatchObject({ agentRishi: true });
  });

  it("doesn't ask for ordinary one-liners", () => {
    neverAsks([
      'python -c "print(1)"',
      'node -e "console.log(1)"',
      "python -c \"import json,sys; print(json.load(open('package.json'))['version'])\"",
      "python -c \"open('/home/me/x').read()\"",
      "python -c \"import os; os.remove('/work/repo/x'); os.remove('/tmp/y')\"",
      "python -c \"open('out.txt','w').write('hi')\"",
      "node -e \"console.log(require('fs').readFileSync('/etc/hosts','utf8'))\"",
      "node -e \"const s=require('fs').readFileSync('a.txt','utf8').split('/'); process.stdout.write(s.join('/'))\"",
      "node -e \"require('fs').writeFileSync('dist/out.json', JSON.stringify({a:1}))\"",
      "node -p \"require('./package.json').version\"",
      "perl -pi -e 's/a/b/' src/a.ts",
      "ruby -e 'puts 1'",
    ]);
    neverAsks(["node -e \"require('fs').writeFileSync('C:/work/repo/x','hi')\""], ps);
  });

  it("reads a path at the root or climbing out, and strings that are text as text", () => {
    asksAtBoth([
      "python -c \"import shutil; shutil.rmtree('/other')\"",
      "python -c \"import shutil; shutil.rmtree('../other')\"",
      "node --eval=\"require('fs').rmSync('/other/x')\"",
    ]);
    neverAsks([
      "node -e \"const fs=require('fs'); fs.writeFileSync('x', fs.readFileSync('x','utf8').replace('/api/v1','/api/v2'))\"",
      "cd packages/x && python -c \"import shutil; shutil.copy('../y/a.txt', 'a.txt')\"",
      "node -e \"require('fs').writeFileSync('routes.json', JSON.stringify(['/', '/about']))\"",
    ]);
  });

  it("reads the commands a one-liner runs from its string literals", () => {
    asksAtBoth([
      "python -c \"import os; os.system('rm -rf /other')\"",
      "python -c \"import subprocess; subprocess.run(['rm', '-rf', '/other/x'])\"",
      "node -e \"require('child_process').execSync('rm -rf /other/x')\"",
      "node -e \"require('child_process').execFileSync('rm', ['-rf', '/other/x'])\"",
      "perl -e 'system(\"rm -rf /other/x\")'",
    ]);
    const token = "python -c \"import os; os.system('cat /home/me/.agent-rishi/install-token')\"";
    expect(classifyCommand(token, posix)).toMatchObject({ agentRishi: true });
    neverAsks([
      "node -e \"require('child_process').execSync('pnpm test', {stdio: 'inherit'})\"",
      "python -c \"import subprocess; print(subprocess.check_output(['git', 'status']))\"",
      "python -c \"import subprocess; subprocess.run(['rm', '-rf', 'dist'])\"",
    ]);
  });

  it("finds rooted string literals only in code that writes", () => {
    expect(inlineCodeWrites("os.remove('/a/b'); print('/c')")).toEqual(["/a/b"]);
    expect(inlineCodeWrites("print(open('/a/b').read())")).toEqual([]);
    expect(inlineCodeWrites("fs.writeFileSync('x', 'https://example.com/a')")).toEqual([]);
    expect(inlineCodeWrites("fs.rmSync('C:\\\\a\\\\b')")).toEqual(["C:\\a\\b"]);
  });
});

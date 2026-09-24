import { describe, it, expect } from 'vitest'
import { isReadOnlyCommand } from '../readOnlyCommand'

describe('isReadOnlyCommand', () => {
  it.each([
    'Get-ChildItem -Force C:/repo',
    'ls -la',
    'dir',
    'Get-Content README.md',
    'cat package.json | head -n 20',
    'type src/main.rs',
    'Test-Path C:/repo/Cargo.toml',
    'Get-Command node; where.exe python',
    'node --version',
    'cargo -V',
    'git status',
    'git --no-pager log --oneline -5',
    'git diff HEAD~1 && git show HEAD',
    'Select-String -Path *.ts -Pattern foo',
    'rg -n TODO src || grep -rn TODO src',
    'Get-Location',
    'pwd',
    'echo hello',
    'Write-Output $env:PATH',
    'Get-ChildItem -Recurse | Measure-Object',
  ])('lets %s through', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  it.each([
    '',
    'npm install',
    'Remove-Item -Recurse x',
    'Get-ChildItem | Remove-Item',
    'ls; rm -rf /',
    'echo hi > file.txt',
    'echo hi >> file.txt',
    'Get-Content a | Out-File b',
    'Get-Content a | Set-Content b',
    'Get-Content a | Add-Content b',
    'Get-Content a | Tee-Object b',
    'cat a | tee b',
    'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
    'Get-ChildItem | Where-Object { $_.Length -gt 0 }',
    'echo $(Remove-Item x)',
    'echo `rm -rf x`',
    '(Remove-Item x)',
    '& ./evil.ps1',
    'ls & del x',
    '. ./evil.ps1',
    'iex "Remove-Item x"',
    'Invoke-Expression "rm x"',
    'Invoke-WebRequest http://x -OutFile y',
    'Start-Process calc',
    'New-Item x',
    'Copy-Item a b',
    'Move-Item a b',
    'Rename-Item a b',
    'git -c core.pager=calc log',
    'git commit -m x',
    'git push',
    'git diff --output=patch.txt',
    'rg --pre ./evil foo',
    './script.ps1 --version',
    'node --version --eval x',
    'echo hi\nRemove-Item x',
    'cmd /c dir',
    'powershell -c ls',
    'Get-Content a < b',
  ])('asks about %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

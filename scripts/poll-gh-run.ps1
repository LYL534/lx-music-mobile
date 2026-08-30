# 带重试轮询 GitHub Actions 运行状态, 直到结束(完成/失败/取消)
param([string]$RunId = "33286659061", [string]$Repo = "LYL534/lx-music-mobile", [int]$MaxMinutes = 120)
$deadline = (Get-Date).AddMinutes($MaxMinutes)
while ((Get-Date) -lt $deadline) {
    $status = $null
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $out = gh run view $RunId -R $Repo --json status,conclusion,jobs 2>$null | ConvertFrom-Json
            $status = $out.status
            break
        } catch { Start-Sleep -Seconds 10 }
    }
    if (-not $status) { Write-Host "[$(Get-Date -Format HH:mm:ss)] network retry failed, will retry next round"; Start-Sleep -Seconds 30; continue }
    Write-Host "[$(Get-Date -Format HH:mm:ss)] status: $status"
    if ($status -eq "completed") {
        Write-Host "=== FINAL ==="
        $out | ConvertTo-Json -Depth 6
        Write-Host "conclusion: $($out.conclusion)"
        return
    }
    Start-Sleep -Seconds 60
}
Write-Host "TIMEOUT: run still not finished after $MaxMinutes minutes"

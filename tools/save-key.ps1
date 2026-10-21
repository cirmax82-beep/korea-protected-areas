# 브이월드 인증키를 이 컴퓨터의 work\vworld_key.txt 에 저장합니다(저장소에는 올라가지 않음: .gitignore).
# 브이월드는 해외 IP 접속을 막아 GitHub 서버에서는 받을 수 없으므로, 경계 받기는 이 컴퓨터에서 합니다.
# 입력 상자(Ctrl+V로 붙여넣기)를 띄우고, 저장한 뒤 실제로 파일이 생겼는지 확인해 알려 줍니다.
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'work'
$path = Join-Path $dir 'vworld_key.txt'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$key = [Microsoft.VisualBasic.Interaction]::InputBox('브이월드 인증키를 붙여 넣고(Ctrl+V) 확인을 누르세요.', '보호구역 종합포털 - 인증키 저장', '').Trim()
if (-not $key) {
    [System.Windows.Forms.MessageBox]::Show('입력이 없어 저장하지 않았습니다.', '보호구역 종합포털') | Out-Null
    Write-Output 'EMPTY'
    exit 1
}
[System.IO.File]::WriteAllText($path, $key)
if ((Test-Path $path) -and ((Get-Content $path -Raw).Trim().Length -eq $key.Length)) {
    [System.Windows.Forms.MessageBox]::Show("저장했습니다($($key.Length)자).", '보호구역 종합포털') | Out-Null
    Write-Output "SAVED $($key.Length)"
} else {
    [System.Windows.Forms.MessageBox]::Show('저장하지 못했습니다.', '보호구역 종합포털') | Out-Null
    Write-Output 'FAILED'
    exit 1
}

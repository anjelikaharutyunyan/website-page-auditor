Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $blueColor = [System.Drawing.Color]::FromArgb(255, 23, 105, 224)
  $greenColor = [System.Drawing.Color]::FromArgb(255, 32, 185, 129)

  if ($size -le 32) {
    # Toolbar icons occupy the entire 16-DIP action slot; draw a simpler mark at native 16px geometry.
    $graphics.ScaleTransform($size / 16.0, $size / 16.0)
    $framePen = [System.Drawing.Pen]::new($blueColor, 1.35)
    $framePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $framePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $check = [System.Drawing.Pen]::new($greenColor, 1.8)
    $check.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $check.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $frame = New-RoundedPath 1.3 1.3 13.4 13.4 1.8
    $blueDot = [System.Drawing.SolidBrush]::new($blueColor)
    $midDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 94, 155, 243))
    $paleDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 168, 204, 255))
    $graphics.DrawPath($framePen, $frame)
    $graphics.DrawLine($framePen, 2.1, 5.4, 13.9, 5.4)
    $graphics.FillEllipse($blueDot, 2.8, 2.8, 1.3, 1.3)
    $graphics.FillEllipse($midDot, 4.8, 2.8, 1.3, 1.3)
    $graphics.FillEllipse($paleDot, 6.8, 2.8, 1.3, 1.3)
    $graphics.DrawLine($check, 4.2, 9.1, 6.2, 11)
    $graphics.DrawLine($check, 6.2, 11, 11.9, 6.5)
    foreach ($object in @($frame, $framePen, $check, $blueDot, $midDot, $paleDot, $graphics)) { $object.Dispose() }
    return $bitmap
  }

  # Store and management artwork keeps the recommended 16px transparent margin on the 128px canvas.
  $scale = $size / 128.0
  $graphics.ScaleTransform($scale, $scale)
  $framePen = [System.Drawing.Pen]::new($blueColor, 8)
  $framePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $framePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $topPen = [System.Drawing.Pen]::new($blueColor, 7)
  $topPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $topPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen = [System.Drawing.Pen]::new($greenColor, 10)
  $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $frame = New-RoundedPath 21 20 86 88 10
  $blueDot = [System.Drawing.SolidBrush]::new($blueColor)
  $midDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 94, 155, 243))
  $paleDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 168, 204, 255))
  $graphics.DrawPath($framePen, $frame)
  $graphics.DrawLine($topPen, 25, 43, 103, 43)
  $graphics.FillEllipse($blueDot, 28.5, 28.5, 7, 7)
  $graphics.FillEllipse($midDot, 39.5, 28.5, 7, 7)
  $graphics.FillEllipse($paleDot, 50.5, 28.5, 7, 7)
  $graphics.DrawLine($checkPen, 39, 74, 57, 92)
  $graphics.DrawLine($checkPen, 57, 92, 92, 57)

  foreach ($object in @($framePen, $topPen, $checkPen, $blueDot, $midDot, $paleDot, $frame, $graphics)) { $object.Dispose() }
  return $bitmap
}

function Save-Icon([string]$path, [int]$size) {
  $bitmap = New-IconBitmap $size
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

foreach ($size in @(16, 32, 48, 128, 512)) {
  Save-Icon (Join-Path $repoRoot "icons/main-$size.png") $size
}
Save-Icon (Join-Path $repoRoot 'icons/main.png') 512
Save-Icon (Join-Path $repoRoot 'icons/store-icon-128.png') 128

$width = 440
$height = 280
$tile = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($tile)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Rectangle]::new(0, 0, $width, $height), [System.Drawing.Color]::FromArgb(255, 11, 36, 85), [System.Drawing.Color]::FromArgb(255, 18, 76, 156), 35)
$g.FillRectangle($bg, 0, 0, $width, $height)
$accentA = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(36, 35, 132, 244))
$accentB = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 33, 200, 160))
$accentC = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(25, 106, 174, 255))
$g.FillEllipse($accentA, 294, -50, 184, 184)
$g.FillEllipse($accentB, -72, 190, 210, 210)
$g.FillEllipse($accentC, 310, 196, 108, 108)

# A clean report card suggests the product workflow without imitating a browser screenshot.
$shadow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(48, 0, 12, 38))
$panel = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 238, 245, 255))
$chromeBar = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 220, 234, 255))
$dark = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 26, 55, 104))
$line = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 179, 197, 223))
$lineLight = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 207, 218, 233))
$success = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 229, 247, 241))
$green = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 32, 185, 129))
$whitePen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 2.6)
$brandFramePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 215, 232, 255), 8)
$brandFramePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$brandFramePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$brandCheckPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 32, 185, 129), 9)
$brandCheckPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$brandCheckPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$smallDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 23, 105, 224))
$middleDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 120, 168, 237))
$lightDot = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 169, 201, 246))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)

$card = New-RoundedPath 61 45 224 168 18
$g.FillPath($shadow, (New-RoundedPath 69 53 224 168 18))
$g.FillPath($panel, $card)
$bar = New-RoundedPath 61 45 224 28 18
$g.FillPath($chromeBar, $bar)
$g.FillRectangle($chromeBar, 61, 59, 224, 14)
$g.FillEllipse($smallDot, 74, 55, 8, 8)
$g.FillEllipse($middleDot, 88, 55, 8, 8)
$g.FillEllipse($lightDot, 102, 55, 8, 8)
$g.FillPath($dark, (New-RoundedPath 78 88 103 10 5))
$g.FillPath($line, (New-RoundedPath 78 107 178 7 3.5))
$g.FillPath($lineLight, (New-RoundedPath 78 122 151 7 3.5))
$g.FillPath($success, (New-RoundedPath 78 145 190 38 10))
$g.FillEllipse($green, 88, 154, 20, 20)
$g.DrawLine($whitePen, 93, 164, 96, 167)
$g.DrawLine($whitePen, 96, 167, 103, 160)
$g.FillPath($line, (New-RoundedPath 116 159 119 6 3))
$g.FillPath($lineLight, (New-RoundedPath 116 170 82 5 2.5))

# Browser window and audit check, matching the extension icon.
$brandFrame = New-RoundedPath 297 79 108 128 14
$g.DrawPath($brandFramePen, $brandFrame)
$g.DrawLine($brandFramePen, 301, 111, 401, 111)
$g.FillEllipse($middleDot, 309, 93, 8, 8)
$g.FillEllipse($lightDot, 323, 93, 8, 8)
$g.FillEllipse($white, 337, 93, 8, 8)
$g.DrawLine($brandCheckPen, 321, 157, 339, 175)
$g.DrawLine($brandCheckPen, 339, 175, 379, 132)

$tilePath = Join-Path $repoRoot 'store/promo-tile-440x280.png'
$tile.Save($tilePath, [System.Drawing.Imaging.ImageFormat]::Png)
foreach ($object in @($bg, $accentA, $accentB, $accentC, $shadow, $panel, $chromeBar, $dark, $line, $lineLight, $success, $green, $whitePen, $brandFramePen, $brandCheckPen, $smallDot, $middleDot, $lightDot, $white, $card, $bar, $brandFrame, $g, $tile)) { $object.Dispose() }

Write-Output "Generated store icon PNG sizes and $tilePath"

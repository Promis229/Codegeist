#!/usr/bin/env bash
# Synthesises the music bed and the sound effects (no external assets): public/audio/{music.mp3,whoosh.wav,pop.wav,click.wav}
set -e
cd "$(dirname "$0")/.."
mkdir -p public/audio

# Ambient pad: two slowly cross-fading chords (Am9 / Fmaj7) with a soft shimmer, a little echo, 5 minutes.
ffmpeg -v error -y -f lavfi -i "aevalsrc='(0.5+0.5*sin(2*PI*t/26))*(0.16*sin(2*PI*110*t)+0.12*sin(2*PI*164.81*t)+0.10*sin(2*PI*220*t)+0.08*sin(2*PI*261.63*t)+0.07*sin(2*PI*329.63*t))+(0.5-0.5*sin(2*PI*t/26))*(0.16*sin(2*PI*87.31*t)+0.12*sin(2*PI*130.81*t)+0.10*sin(2*PI*174.61*t)+0.08*sin(2*PI*220*t)+0.07*sin(2*PI*261.63*t))+0.025*sin(2*PI*880*t)*pow(sin(2*PI*0.11*t),2)':s=48000:d=300" \
  -af "lowpass=f=2200,aecho=0.8:0.65:620|1040:0.32|0.22,tremolo=f=0.16:d=0.22,afade=t=in:d=5,afade=t=out:st=290:d=9,volume=0.8" -b:a 192k public/audio/music.mp3

ffmpeg -v error -y -f lavfi -i "anoisesrc=d=0.8:c=pink:a=0.6" -af "bandpass=f=1500:w=2200,afade=t=in:d=0.4:curve=exp,afade=t=out:st=0.4:d=0.4,volume=0.9" -ar 48000 public/audio/whoosh.wav
# Bell chime ("ki-ki-oun"): two quick high pings, then a lower bell that rings out (inharmonic partials, exponential decay).
ffmpeg -v error -y -f lavfi -i "aevalsrc='0.34*exp(-t*16)*(sin(2*PI*1318.5*t)+0.35*sin(2*PI*3532*t)) + gte(t,0.09)*0.34*exp(-(t-0.09)*16)*(sin(2*PI*1760*(t-0.09))+0.35*sin(2*PI*4700*(t-0.09))) + gte(t,0.19)*0.5*exp(-(t-0.19)*4.2)*(sin(2*PI*880*(t-0.19))+0.45*sin(2*PI*2112*(t-0.19))+0.25*sin(2*PI*2640*(t-0.19))+0.12*sin(2*PI*4224*(t-0.19)))':s=48000:d=1.3" -af "afade=t=out:st=1.0:d=0.3,volume=0.9" public/audio/pop.wav
ffmpeg -v error -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*2400*t)*exp(-t*95)+0.3*sin(2*PI*980*t)*exp(-t*60)':d=0.12:s=48000" public/audio/click.wav
ls -la public/audio

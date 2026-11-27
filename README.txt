Surveyor's Little Helper - SLH-v0.6
Put every file in this folder at the top level of your GitHub repository (keep the data and icons folders).
data/townships.json and data/ngs.json are included. ngs.json has Knox County marks only so far.
To add Cedar: download Cedar from the NGS datasheets page, then run  python convert_ngs.py knox.zip cedar.zip  and replace data/ngs.json.
Surveyor names: edit data/surveyors.json, one line per license like  "657": "Lastname"
Test without GPS: add ?lat=42.5985&lon=-97.6451 to the web address (optionally &r=1.5 for miles).

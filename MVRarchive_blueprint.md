## Project: Web app MVRarchive for PC browsing.

It is a pure web code and is hosted by OmniGate. must start with index.html. Use Omnigate API to get access to files. See file README-OmniGate-side-apps.md.

### Idea

Create a web app similar by a look to the MVR Archive on Android (code is in folder C:\\Alex\\mvr). Web app should scroll and search through the folders in the MVR Archive standard, created by Sending to NAS or recording directly to NAS. Every folder (we call it Study, imaging Study) can contain Study data in YAML format (Patient, doctor, equipment, etc.) and recorded images, videos and created reports.
Gather style from the Android MVR app related to Archive - colors, icons, other visual and styling resources.
Collect initial list of functions from the MVR Archive code: scrolling Study folders, searching, copying, edit Study info, send to PACS, edit and annotate images, trim and stitch videos, create reports.

OmniGate app location: C:\\Alex\\omnigate
To deploy code: copy current web code to folder C:\\Alex\\omnigate\\data\\apps\\mvrarchive


# Send to PACS: study metadata → DICOM mapping

How a study folder's `study_info.yaml` / `patient_info.json` becomes the DICOM
tags of the objects OmniGate sends with C-STORE. Mirrors the MVR recorder's own
dicomizer (`C:\Alex\mvr` — `dicom/DicomWriter.kt`, `study/DicomStudyInfo.kt`),
so a study sent from the archive lands in PACS like one sent from the recorder.

## Where the code is

| Step | Code |
|---|---|
| Read metadata, build the tag map per study | `js/study.js` → `dicomTags(study)` |
| Pick sendable files, one request per file | `js/ui.js` Send-to-PACS flow → `POST api/pacs/{name}/send` `{path, tags}` |
| Device defaults (fill what the client left out) | `omnigate/internal/pacs/pacs.go` → `Defaults()` |
| Tag dictionary (keyword → tag, VR) | `omnigate/internal/dicom/dict.go` |
| Object writer per media type | `omnigate/internal/dicom/wrap.go` → `Wrap`, `JPEG`, `RGB`, `Video`, `PDF` |
| MP4 probe (size, codec, frames, duration) | `omnigate/internal/dicom/mp4.go` |
| Transfer | `storescu` (DCMTK); `dcmodify` only to re-tag an existing `.dcm` |

Only tags in the dictionary can be written into a wrapped object (the VR must
be known). An unknown keyword answers `400`. Existing `.dcm` files accept any
keyword because `dcmodify` resolves it.

## Metadata → tags (client, `dicomTags`)

Metadata keys are the JSON/YAML names written by the recorder. A key absent or
empty produces no tag. `first non-empty wins` lists alternatives in order.

### Patient

| DICOM tag | VR | From metadata | Rule |
|---|---|---|---|
| PatientName (0010,0010) | PN | `AnimalName`, else `PatientLastName^PatientFirstName^PatientMiddleName` | trailing `^` trimmed |
| PatientID (0010,0020) | LO | `PatientID`, else `StudyID` | |
| IssuerOfPatientID (0010,0021) | LO | `IssuerOfPatientId` | |
| PatientBirthDate (0010,0030) | DA | `PatientBirthYear` + `PatientBirthMonth` + `PatientBirthDay` | only when all three present → `YYYYMMDD` |
| PatientSex (0010,0040) | CS | `PatientGender` | first letter upper-cased, sent only if M/F/O |
| OtherPatientIDs (0010,1000) | LO | `OtherPatientIds` | |
| PatientAddress (0010,1040) | LO | `PatientAddress` | |
| MilitaryRank (0010,1080) | LO | `MilitaryRank` | |
| MedicalAlerts (0010,2000) | LO | `MedicalAlerts` | |
| Allergies (0010,2110) | LO | `Allergies` | |
| AdditionalPatientHistory (0010,21B0) | LT | `AdditionalPatientHistory` | |
| PregnancyStatus (0010,21C0) | US | `PregnancyStatus` | 1–4 only |
| LastMenstrualDate (0010,21D0) | DA | `LastMenstrualDate` | |
| PatientSpeciesDescription (0010,2201) | LO | `SpeciesDescription` | veterinary |
| PatientBreedDescription (0010,2292) | LO | `BreedCode` | veterinary |
| ResponsiblePerson (0010,2297) | PN | `ResponsiblePerson` | |
| ResponsiblePersonRole (0010,2298) | CS | `ResponsiblePersonRole` | |

### Study / request

| DICOM tag | VR | From metadata | Rule |
|---|---|---|---|
| StudyInstanceUID (0020,000D) | UI | `StudyInstanceUID` | else `2.25.<128-bit hash of the folder name>`: stable across sessions and devices, so a resend joins the same PACS study |
| StudyDate (0008,0020) | DA | `WlStudyDate`, else `StudyDate` (epoch ms), else folder-name timestamp | |
| StudyTime (0008,0030) | TM | `WlStudyTime`, else same source as StudyDate | |
| AccessionNumber (0008,0050) | SH | `AccessionNumber` | |
| StudyDescription (0008,1030) | LO | `PatientNotes` | recorder's "notes" |
| RequestedProcedureDescription (0032,1060) | LO | `RequestedProcedureDescription`, else `PatientNotes` | |
| ReferringPhysicianName (0008,0090) | PN | `ReferringPhysician` | |
| PerformingPhysicianName (0008,1050) | PN | `PerformingPhysician` | |
| RequestingPhysician (0032,1032) | PN | `RequestingPhysician` | |
| PhysiciansOfRecord (0008,1048) | PN | `RequestingPhysician` | as the recorder does |
| InstitutionName (0008,0080) | LO | `InstitutionName` | worklist value overrides the device default |
| InstitutionAddress (0008,0081) | ST | `InstitutionAddress` | |
| InstitutionalDepartmentName (0008,1040) | LO | `InstitutionDepartmentName` | |
| BodyPartExamined (0018,0015) | CS | `BodyPartExamined` | |
| Laterality (0020,0060) | CS | `Laterality` | |
| AdmissionID (0038,0010) | LO | `AdmissionID` | |
| SpecialNeeds (0038,0050) | LO | `SpecialNeeds` | |
| RequestedProcedureID (0040,1001) | SH | `RequestedProcedureID` | |
| RequestedProcedureComments (0040,1400) | LT | `RequestedProcedureComments` | |
| PlacerOrderNumber (0040,2016) | LO | `PlacerOrderNumber` | |

Not mapped (the recorder writes them, the archive does not yet): anatomic
region / modifier code sequences (`AnatomicRegion`, `AnatomicModifier1/2`),
requested procedure code sequence, scheduled procedure step attributes,
referenced SOP sequence, operator's name, image comments from JPEG EXIF /
MP4 `©cmt`, audio channel description for videos with sound.

## Device defaults (server, `pacs.Defaults`)

Filled in only when the client's tags do not carry the tag. Values come from
OmniGate's Settings → Device card.

| DICOM tag | Value |
|---|---|
| Modality (0008,0060) | `XC` |
| Manufacturer (0008,0070) | `MediCapture Inc` |
| ManufacturerModelName (0008,1090) | `MSP` |
| DeviceID (0018,1003) | OmniGate device id |
| SoftwareVersions (0018,1020) | OmniGate version |
| StationName (0008,1010) | Device title |
| InstitutionName (0008,0080) / InstitutionAddress (0008,0081) / InstitutionalDepartmentName (0008,1040) | Device institution / address / department |
| PerformedLocation (0040,0243) | Device location |
| StudyDate/Time, SeriesDate/Time, ContentDate/Time | send time (StudyDate/Time normally already set by the client) |

## Per-file attributes (server, `dicom.Wrap`)

Set by the writer from the file itself; the caller's tags never override
them, except the UIDs and series/instance numbers.

| | JPEG (`.jpg`) | BMP (`.bmp`) | MP4 (`.mp4`) | PDF (`.pdf`) |
|---|---|---|---|---|
| SOP class | VL Photographic Image `…77.1.4` | VL Photographic Image | Video Photographic Image `…77.1.4.1` | Encapsulated PDF `…104.1` |
| Transfer syntax | JPEG Baseline `1.2.4.50` | Explicit VR LE | H.264 `1.2.4.102` / HEVC `1.2.4.107` | Explicit VR LE |
| Payload | JPEG bytes encapsulated, one fragment | decoded to 8-bit RGB, native pixel data | MP4 bytes encapsulated, one fragment (≤ 4 GB) | PDF bytes in EncapsulatedDocument (0042,0011) |
| Rows / Columns | from JPEG header | from BMP header | from `stsd` | – |
| PhotometricInterpretation | YBR_FULL_422 (MONOCHROME2 for grey) | RGB | YBR_PARTIAL_420 | – |
| LossyImageCompression | 01 | 00 | 01 | – |
| ConversionType (0008,0064) | DI | DI | DV | – |
| NumberOfFrames / FrameTime / CineRate | 1 | 1 | from `stts` / `mdhd` | – |
| SeriesNumber (0020,0011) | 1 | 1 | 2 | 3 |
| InstanceNumber (0020,0013) | trailing digits of the file name (`I0007` → 7), else 1 | same | same | same |
| Extra | PixelAspectRatio 1\1 | PixelAspectRatio 1\1 | FrameIncrementPointer → FrameTime | BurnedInAnnotation YES, DocumentTitle `Report`, MIME `application/pdf`, empty AcquisitionContext / ConceptNameCode sequences |

Always: SpecificCharacterSet `ISO_IR 192` (UTF-8), ImageType
`ORIGINAL\PRIMARY`, empty PatientOrientation for images/video.

UIDs follow the recorder's scheme: SeriesInstanceUID =
`<StudyInstanceUID>.<SeriesNumber>`, SOPInstanceUID =
`<SeriesInstanceUID>.<InstanceNumber>`. Same study + same file → same
instance, so a PACS sees a resend as a duplicate. Random `2.25.<uuid>` UIDs
are used only when no StudyInstanceUID is given or the derived UID would
exceed 64 characters.

Association: a wrapped object is sent with a generated one-context storescu
profile proposing exactly its SOP class and transfer syntax (uncompressed
objects also offer implicit VR LE). storescu's `--propose-*` flags are not
used: they propose for every storage class and exhaust the 128 presentation
contexts before the video classes.

## Adding a tag

1. Add the keyword with its tag and VR to `dict.go` (`Dictionary`).
2. Map the metadata key in `study.js` `dicomTags` (`map` object) or, for a
   device value, in `pacs.Defaults`.
3. `go test ./internal/dicom ./internal/pacs` — `TestWrapRealStudyDCMTK`
   validates every object of the sample study with `dcmdump` when DCMTK is
   installed.

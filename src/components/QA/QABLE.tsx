import React, { useState } from 'react';
import { View, StyleSheet, Button, Alert, ScrollView, Clipboard } from 'react-native';
import { connect } from 'react-redux';
import DocumentPicker from 'react-native-document-picker';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import Share from 'react-native-share';
import prompt from 'react-native-prompt-android';
import { check, PERMISSIONS, request, RESULTS } from 'react-native-permissions';
import { bindActionCreators } from 'redux';
import AsyncStorage from '@react-native-community/async-storage';
import moment from 'moment';
import Geohash from 'latlon-geohash';
// @ts-ignore
import SpecialBle from 'rn-contact-tracing';
import RNFetchBlob from 'rn-fetch-blob';
import PopupForQA from './PopupForQA';
import { Icon, TouchableOpacity, Text } from '../common';
import { updatePointsFromFile } from '../../actions/ExposuresActions';
import { checkGeoSickPeople, checkBLESickPeople, checkSickPeopleFromFile, queryDB } from '../../services/Tracker';
import { insertToSampleDB, kmlToGeoJson } from '../../services/LocationHistoryService';
import { getUserLocationsReadyForServer } from '../../services/DeepLinkService';
import { clusterSample } from '../../services/ClusteringService';
import { UserClusteredLocationsDatabase, UserLocationsDatabase } from '../../database/Database';
import { onError } from '../../services/ErrorService';
import config from '../../config/config';
import { Exposure } from '../../types';
import {
  ALL_POINTS_QA,
  CLUSTERING_RESULT_LOG_FOR_QA,
  HIGH_VELOCITY_POINTS_QA, IS_IOS,
  PADDING_BOTTOM,
  PADDING_TOP,
  SERVICE_TRACKER
} from '../../constants/Constants';

interface Props {
  navigation: any,
  updatePointsFromFile(points: Exposure[]): void
}

const SICK_FILE_TYPE = 1;
const LOCATIONS_FILE_TYPE = 2;
const KML_FILE_TYPE = 3;
const CLUSTERS_FILE_TYPE = 4;
const BLE_MATCH_FILE_TYPE = 5;
const BLE_DB_FILE_TYPE = 6;

const QABLE = ({ navigation, updatePointsFromFile }: Props) => {
  const [{ showPopup, type }, setShowPopup] = useState<{ showPopup: boolean, type: string }>({ showPopup: false, type: '' });

  const fetchFromFileWithAction = async (fileType: number, isClusters?: boolean) => {
    try {
      const isStoragePermissionGranted = await check(PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE);
      if (isStoragePermissionGranted === RESULTS.GRANTED) {
        await chooseFile(fileType, isClusters);
      } else {
        const requestPermissionRes = await request(PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE);
        if (requestPermissionRes === RESULTS.GRANTED) {
          await chooseFile(fileType, isClusters);
        }
      }
    } catch (err) {
      console.log(err);
    }
  };

  const chooseFile = async (fileType: number, isClusters?: boolean) => {
    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.allFiles]
      });

      const fileUri = res.uri;
      const rawText = await RNFS.readFile(fileUri);

      switch (fileType) {
        case SICK_FILE_TYPE: {
          const pointsJSON = JSON.parse(rawText.trim());
          updatePointsFromFile(pointsJSON);
          await checkSickPeopleFromFile(isClusters);
          return;
        }

        case KML_FILE_TYPE: {
          try {
            const pointsEntered = await insertToSampleDB(kmlToGeoJson(rawText));
            return Alert.alert(`KML loaded - ${pointsEntered} points`);
          } catch (e) {
            return Alert.alert('KML loading failed');
          }
        }

        case CLUSTERS_FILE_TYPE: {
          const cdb = new UserClusteredLocationsDatabase();

          // clusters file
          const clustersArr: string[] = rawText.split('\n');
          let isFirst = true;

          for (const item of clustersArr) {
            if (!isFirst) { // to ignore the first row which holds the titles...
              const clusterArr = item.split(',');

              if (clusterArr.length >= 5) {
                await cdb.addCluster({
                  lat: parseFloat(clusterArr[0]),
                  long: parseFloat(clusterArr[1]),
                  startTime: parseFloat(clusterArr[2]),
                  endTime: parseFloat(clusterArr[3]),
                  geoHash: Geohash.encode(parseFloat(clusterArr[0]), parseFloat(clusterArr[1]), 12),
                  radius: parseFloat(clusterArr[4]),
                  size: parseFloat(clusterArr[5])
                });
              }
            }

            isFirst = false;
          }

          return;
        }

        case LOCATIONS_FILE_TYPE: {
          const db = new UserLocationsDatabase();

          // location file
          const pointsArr: string[] = rawText.split('\n');
          let isFirst = true;

          for (const item of pointsArr) {
            if (!isFirst) { // to ignore the first row which holds the titles...
              const sampleArr = item.split(',');

              if (sampleArr.length >= 4) {
                await db.addSample({
                  lat: parseFloat(sampleArr[0]),
                  long: parseFloat(sampleArr[1]),
                  accuracy: parseFloat(sampleArr[2]),
                  startTime: parseFloat(sampleArr[3]),
                  endTime: parseFloat(sampleArr[4]),
                  geoHash: Geohash.encode(parseFloat(sampleArr[0]), parseFloat(sampleArr[1]), 12),
                  wifiHash: ''
                });
                await clusterSample();
              }
            }

            isFirst = false;
          }

          return;
        }

        case BLE_MATCH_FILE_TYPE: {
          SpecialBle.match(rawText, async (res: any) => {
            const filepath = `${RNFS.CachesDirectoryPath}/${`BLEMatch_${moment().valueOf()}.json`}`;
            await RNFS.writeFile(filepath, res || '{}', 'utf8');
            await Share.open({ title: 'שיתוף BLE match', url: IS_IOS ? filepath : `file://${filepath}` });
          });

          break;
        }

        case BLE_DB_FILE_TYPE: {
          SpecialBle.writeContactsToDB(rawText);
          return;
        }

        default: return;
      }
    } catch (error) {
      if (DocumentPicker.isCancel(error)) {
        // User cancelled the picker, exit any dialogs or menus and move on
      } else {
        throw error;
      }
    }
  };

  const copyConfig = () => {
    Alert.alert('Config was copied', '', [{ text: 'OK' }]);
    Clipboard.setString(JSON.stringify(config()));
  };

  const shareShareLocationsInfo = async () => {
    try {
      const filename = 'locationsData.json';
      const baseDir = RNFS.CachesDirectoryPath;
      const filepath = `${baseDir}/${filename}`;

      await RNFS.writeFile(filepath, JSON.stringify(await getUserLocationsReadyForServer('XXXX')), 'utf8');
      await Share.open({ title: 'שיתוף מיקומי חולה מאומת', url: IS_IOS ? filepath : `file://${filepath}` });
    } catch (error) {
      onError({ error });
    }
  };

  const shareBLEData = () => {
    try {
      SpecialBle.fetchInfectionDataByConsent(async (res: any) => {
        const filepath = `${RNFS.CachesDirectoryPath}/${`BLEData_${moment().valueOf()}.json`}`;
        await RNFS.writeFile(filepath, res || '{}', 'utf8');
        await Share.open({ title: 'שיתוף BLE data', url: IS_IOS ? filepath : `file://${filepath}` });
      });
    } catch (error) {
      onError({ error });
    }
  };

  const initCheckSickPeople = async (isClusters: boolean) => {
    try {
      await checkGeoSickPeople(true, isClusters);
      Alert.alert('Checking...', '', [{ text: 'OK' }]);
    } catch (e) {
      Alert.alert('Error', '', [{ text: 'OK' }]);
    }
  };

  const clearHVP = async () => {
    try {
      await AsyncStorage.removeItem(HIGH_VELOCITY_POINTS_QA);
      Alert.alert('Cleared', '', [{ text: 'OK' }]);
    } catch (e) {
      Alert.alert('Error', '', [{ text: 'OK' }]);
    }
  };

  const clearAllPoints = async () => {
    try {
      await AsyncStorage.removeItem(ALL_POINTS_QA);
      Alert.alert('Cleared', '', [{ text: 'OK' }]);
    } catch (e) {
      Alert.alert('Error', '', [{ text: 'OK' }]);
    }
  };

  const clearLocationsDB = () => {
    const db = new UserLocationsDatabase();
    db.purgeSamplesTable(moment().valueOf());
    Alert.alert('Cleared', '', [{ text: 'OK' }]);
  };

  const clearClustersDB = () => {
    const cdb = new UserClusteredLocationsDatabase();
    cdb.purgeClustersTable(moment().valueOf());
    Alert.alert('Cleared', '', [{ text: 'OK' }]);
  };

  const copyServicesTrackingData = async () => {
    const res: Array<{ source: string, timestamp: number }> = JSON.parse(await AsyncStorage.getItem(SERVICE_TRACKER) || '[]');

    let csv = 'source, timestamp\n';

    res.forEach(({ source, timestamp }: any) => {
      csv += `${source},${timestamp}\n`;
    });

    Clipboard.setString(csv);
    Alert.alert('Services data copied', '', [{ text: 'OK' }]);
  };

  const clearServicesTrackingData = async () => {
    await AsyncStorage.removeItem(SERVICE_TRACKER);
    Alert.alert('Cleared', '', [{ text: 'OK' }]);
  };

  const clearClustersLogs = async () => {
    await AsyncStorage.removeItem(CLUSTERING_RESULT_LOG_FOR_QA);
    Alert.alert('Cleared', '', [{ text: 'OK' }]);
  };

  const copyAllData = async () => {
    const allPoints = JSON.parse(await AsyncStorage.getItem(ALL_POINTS_QA) || '[]');
    const DBPoints = await queryDB(false);
    const CDBPoints = await queryDB(true);
    const HVPoints = JSON.parse(await AsyncStorage.getItem(HIGH_VELOCITY_POINTS_QA) || '[]');
    const services = JSON.parse(await AsyncStorage.getItem(SERVICE_TRACKER) || '[]');
    const clustersLog = JSON.parse(await AsyncStorage.getItem(CLUSTERING_RESULT_LOG_FOR_QA) || '[]');

    let csv = 'All Points\n';

    allPoints.forEach((point: any) => {
      const { lat, long, accuracy, startTime, endTime, reason, eventTime } = point;
      csv += `${lat},${long},${accuracy},${startTime},${endTime},${reason || ''},${eventTime || ''}\n`;
    });

    csv += 'DB Points\n';

    DBPoints.forEach((point: any) => {
      const { lat, long, accuracy, startTime, endTime, reason, eventTime } = point;
      csv += `${lat},${long},${accuracy},${startTime},${endTime},${reason || ''},${eventTime || ''}\n`;
    });

    csv += 'Cluster DB Points\n';

    CDBPoints.forEach((point: any) => {
      const { lat, long, startTime, endTime, radius, size } = point;
      csv += `${lat},${long},${startTime},${endTime},${radius},${size}\n`;
    });

    csv += 'HV Points\n';

    HVPoints.forEach((point: any) => {
      const { lat, long, accuracy, startTime, endTime, reason, eventTime } = point;
      csv += `${lat},${long},${accuracy},${startTime},${endTime},${reason || ''},${eventTime || ''}\n`;
    });

    csv += 'Services\n';

    services.forEach((point: any) => {
      const { source, timestamp } = point;
      csv += `${source},${timestamp}\n`;
    });

    csv += 'Clusters log\n';

    clustersLog.forEach((point: any) => {
      const { lat, long, accuracy, startTime, endTime, reason } = point;
      csv += `${lat},${long},${accuracy},${startTime},${endTime},${reason || ''}\n`;
    });

    Alert.alert('הועתק', '', [{ text: 'OK', onPress: () => console.log('OK Pressed') }]);
    Clipboard.setString(csv);
  };

  const writeToBLEDBFromUrl = async () => {
    const onUrlEntered = async (url: string) => {
      try {
        const res = await RNFetchBlob.fetch('GET', url);
        SpecialBle.writeContactsToDB(res.data);
        Alert.alert('Data added to BLE DB');
      } catch (error) {
        onError({ error, showError: true, messageToShow: 'Failed to add data' });
      }
    };

    prompt('הכנס URL להורדה', undefined, [{ text: 'Cancel', onPress: () => { }, style: 'cancel' }, { text: 'OK', onPress: onUrlEntered, style: 'default' }], { type: 'plain-text' });
  };

  const matchBLEFromUrl = async () => {
    const onUrlEntered = async (url: string) => {
      try {
        const res = await RNFetchBlob.fetch('GET', url);
        SpecialBle.match(res.data, async (res: any) => {
          const filepath = `${RNFS.CachesDirectoryPath}/${`BLEMatchFromURL_${moment().valueOf()}.json`}`;
          await RNFS.writeFile(filepath, res || '{}', 'utf8');
          await Share.open({ title: 'שיתוף BLE match', url: IS_IOS ? filepath : `file://${filepath}` });
        });
      } catch (error) {
        onError({ error, showError: true, messageToShow: 'Failed download file' });
      }
    };

    prompt('הכנס URL להורדה', undefined, [{ text: 'Cancel', onPress: () => { }, style: 'cancel' }, { text: 'OK', onPress: onUrlEntered, style: 'default' }], { type: 'plain-text' });
  };

  const getAllBLEScans = () => {
    try {
      SpecialBle.getAllScans(async (res: any) => {
        const filepath = `${RNFS.CachesDirectoryPath}/${`BLEScans_${moment().valueOf()}.json`}`;
        await RNFS.writeFile(filepath, JSON.stringify(res) || '[]', 'utf8');
        await Share.open({ title: 'שיתוף BLE scans', url: IS_IOS ? filepath : `file://${filepath}` });
      });
    } catch (error) {
      onError({ error });
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.close} onPress={navigation.goBack}>
        <Icon source={require('../../assets/onboarding/close.png')} width={31} />
      </TouchableOpacity>

      <Text style={{ marginBottom: 30, fontSize: 25 }} bold>{'תפריט BLE בדיקות נסתר\nלבודק(ת) הנהדר(ת)'}</Text>

      <ScrollView>

        <View style={styles.buttonWrapper}>
          <Button title="BLE match מקובץ" onPress={() => fetchFromFileWithAction(BLE_MATCH_FILE_TYPE)} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="BLE match מ-URL" onPress={matchBLEFromUrl} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="טען BLE DB מקובץ" onPress={() => fetchFromFileWithAction(BLE_DB_FILE_TYPE)} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="טען BLE DB מ URL" onPress={writeToBLEDBFromUrl} />
        </View>
        
        <View style={styles.buttonWrapper}>
          <Button title="Share ephemerals " onPress={() => SpecialBle.exportAllContactsAsCsv()} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="שתף מידע BLE" onPress={shareBLEData} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="שתף סריקות BLE" onPress={getAllBLEScans} />
        </View>

        <View style={styles.buttonWrapper}>
          <Button title="!!!!!נקה BLE DB!!!!!" onPress={() => {
            SpecialBle.cleanScansDB()
            SpecialBle.cleanDevicesDB()
            Alert.alert('Cleared', '', [{ text: 'OK' }]);
          }} color="red" />
        </View>
      </ScrollView>

      <View style={{ marginBottom: PADDING_BOTTOM(20) }}>
        <Text>{DeviceInfo.getVersion()}</Text>
      </View>
      <PopupForQA isVisible={showPopup} type={type} closeModal={() => setShowPopup({ showPopup: false, type: '' })} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: PADDING_TOP(50),
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#fff'
  },
  close: {
    position: 'absolute',
    top: PADDING_TOP(20),
    left: 20,
    zIndex: 1000
  },
  buttonsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  buttonWrapper: {
    marginBottom: 10
  }
});

const mapDispatchToProps = {
    updatePointsFromFile 
}

export default connect(null, mapDispatchToProps)(QABLE);
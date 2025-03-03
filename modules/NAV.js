// Oct 25th 2011 21:38 UTC
// 1F 40 21 38 25 00 10 20 11
//    ?? %H %M %d ?? %m %C %y

// Parse GPS time and date message
function parse_gps_time(data) {
	data.command = 'bro';
	data.value   = 'GPS date and time';

	data.parse = {
		day    : parseInt(data.msg[4].toString(16)),
		hour   : parseInt(data.msg[2].toString(16)),
		minute : parseInt(data.msg[3].toString(16)),
		month  : parseInt(data.msg[6].toString(16)),
		year   : parseInt(data.msg[7].toString(16) + data.msg[8].toString(16)),

		string : null,
	};

	data.parse.string  = data.parse.year.toString() + '-' + data.parse.month.toString() + '-' + data.parse.day.toString() + ' ';
	data.parse.string += data.parse.hour.toString() + ':' + data.parse.minute + ' UTC';

	data.value += ': ' + data.parse.string;

	return data;
}

// Broadcast: Current GPS position
function parse_gps_position(data) {
        data.command = 'bro';
        data.value   = 'GPS position';

        // data.msg[1] = 0x01 : GPS fix
        data.parse = {
                latitudeDegrees     : data.msg[3].toString(16),
                latitudeMinutes     : data.msg[4].toString(16),
                latitudeSeconds     : data.msg[5].toString(16),
                latitudeFractional  : data.msg[6].toString(16),
                latitudeDirection   : (data.msg[6] & 15) === 1 ? 'S' : 'N',
                longitudeDegrees    : data.msg[8].toString(16),
                longitudeMinutes    : data.msg[9].toString(16),
                longitudeSeconds    : data.msg[10].toString(16),
                longitudeFractional : data.msg[11].toString(16),
                longitudeDirection  : (data.msg[11] & 15) === 1 ? 'W' : 'E',
                altitude            : data.msg[12] * 100 + data.msg[13]

                string : null,
        };

        if (data.parse.latitudeDegrees > 90) {
                data.parse.string = '-' + (data.parse.latitudeDegrees - 180) + '°';
        } else {
                data.parse.string = data.parse.latitudeDegrees + '°';
        }
        data.parse.string += data.parse.latitudeMinutes + "'";
        data.parse.string += data.parse.latitudeSeconds + '.';
        data.parse.string += data.parse.latitudeFractional +'"';
        data.parse.string += data.parse.latitudeDirection + ', ';

        data.parse.string += data.parse.longitudeDegrees + '°';
        data.parse.string += data.parse.longitudeMinutes + "'";
        data.parse.string += data.parse.longitudeSeconds + '.';
        data.parse.string += data.parse.longitudeFractional +'"';
        data.parse.string += data.parse.longitudeDirection + ', ';

        data.parse.string += ', Altitude: ' + data.parse.string.altitude.toString() + 'm';

        data.value += ': ' + data.parse.string;

        return data;
}

// Broadcast: Current location name
function parse_location_name(data) {
        data.command = 'bro';
        data.value   = 'GPS location, ';
        asciiArray = data.slice(3);

        if (data.msg[2] == 0x01) {
		        data.value += 'City: ' + asciiArray.filter(code => code !== 0).map(code => String.fromCharCode(code)).join('');
		}
		if (data.msg[2] == 0x02) {
		        data.value += 'Street: ' + asciiArray.filter(code => code !== 0).map(code => String.fromCharCode(code)).join('');
		}

        return data;
}

// Request: TMC status
function parse_tmc_status(data) {
	data.command = 'req';
	data.value   = 'TMC status, update class: ' + hex.i2s(data.msg[1]);

	// Src : NAV
	// Dst : TEL
	//
	// data.msg[1] = 0x03 : Current network request
	// data.msg[1] = 0x0A : Current phone status
	//
	//
	// [ 0xA9, 0x03, 0x30, 0x30 ] = Current_network_request  Count_0
	// [ 0xA9, 0x0A, 0x30, 0x30 ] = Current_phone_status     Count_0

	return data;
}

// Broadcast: Telephone data
function parse_telephone_data(data) {
	data.command = 'bro';
	data.value   = 'TODO: telephone data';

	return data;
}


// Parse data sent from module
function parse_out(data) {
	switch (data.msg[0]) {
		case 0x1F : return parse_gps_time(data);
		case 0xA2 : return parse_gps_position(data);
		case 0xA4 : return parse_location_name(data);
		case 0xA7 : return parse_tmc_status(data);
		case 0xA9 : return parse_telephone_data(data);
	}

	return data;
}


module.exports = {
	parse_out,
};
